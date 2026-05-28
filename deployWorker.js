/**
 * Deployment Worker
 * -----------------
 * Run this as a separate process: `npm run worker`
 *
 * For each job it:
 *  1. Marks deployment as "running"
 *  2. Sends an SSM RunCommand to the EC2 instance to pull + run the Docker container
 *  3. Polls SSM until the command completes or fails
 *  4. Invokes an AWS Lambda function for post-deploy setup
 *  5. Marks deployment as "completed" or "failed"
 */

import "dotenv/config";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import mongoose from "mongoose";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import Deployment from "../models/Deployment.js";

// ─── AWS Clients ───────────────────────────────────────────────────────────────
const ssmClient = new SSMClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const lambdaClient = new LambdaClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ─── Redis connection ─────────────────────────────────────────────────────────
const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  maxRetriesPerRequest: null,
});

// ─── MongoDB ──────────────────────────────────────────────────────────────────
await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/controlpanel");
console.log("✓ Worker connected to MongoDB");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Appends a line to deployment.logs and persists immediately.
 * Keeps the live-updating UI in sync via the polling endpoint.
 */
async function appendLog(deploymentId, line) {
  console.log(`[${deploymentId}] ${line}`);
  await Deployment.findByIdAndUpdate(deploymentId, {
    $push: { logs: line },
    updatedAt: new Date(),
  });
}

/**
 * Polls SSM GetCommandInvocation until the command reaches a terminal state.
 * Returns { success: boolean, output: string }
 */
async function waitForSSMCommand(commandId, instanceId, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  const terminalStates = ["Success", "Failed", "TimedOut", "Cancelled", "Undeliverable"];

  while (Date.now() - start < timeoutMs) {
    await sleep(4000);
    try {
      const result = await ssmClient.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId })
      );
      if (terminalStates.includes(result.StatusDetails)) {
        return {
          success: result.StatusDetails === "Success",
          output:  result.StandardOutputContent || result.StandardErrorContent || result.StatusDetails,
        };
      }
    } catch (err) {
      // Invocation may not be registered yet — retry
      if (!err.message.includes("InvocationDoesNotExist")) throw err;
    }
  }
  return { success: false, output: "SSM command timed out." };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Core deployment processor ────────────────────────────────────────────────
async function processDeployment(job) {
  const { deploymentId, clientName, domain, image } = job.data;

  // Mark as running
  await Deployment.findByIdAndUpdate(deploymentId, { status: "running" });

  // ── Step 1: Docker on EC2 via AWS SSM ──────────────────────────────────────
  await appendLog(deploymentId, `Starting deployment for ${clientName}`);
  await appendLog(deploymentId, `Target domain: ${domain}`);
  await appendLog(deploymentId, `Docker image: ${image}`);
  await appendLog(deploymentId, "Sending SSM RunCommand to EC2 instance...");

  const containerName = `client-${clientName.toLowerCase().replace(/\s+/g, "-")}`;

  // The shell script that runs on the EC2 instance
  const dockerScript = [
    `set -e`,
    `echo "Pulling image: ${image}"`,
    `docker pull ${image}`,
    `echo "Stopping existing container if present..."`,
    `docker stop ${containerName} 2>/dev/null || true`,
    `docker rm   ${containerName} 2>/dev/null || true`,
    `echo "Starting container..."`,
    `docker run -d \\`,
    `  --name ${containerName} \\`,
    `  --restart unless-stopped \\`,
    `  -e VIRTUAL_HOST=${domain} \\`,
    `  -e LETSENCRYPT_HOST=${domain} \\`,
    `  ${image}`,
    `echo "Container ${containerName} is running"`,
    `docker ps --filter name=${containerName} --format "table {{.ID}}\\t{{.Image}}\\t{{.Status}}"`,
  ].join("\n");

  let commandId;
  try {
    const ssmResp = await ssmClient.send(
      new SendCommandCommand({
        InstanceIds:  [process.env.EC2_INSTANCE_ID],
        DocumentName: "AWS-RunShellScript",
        Parameters:   { commands: [dockerScript] },
        Comment:      `Deploy ${image} for ${clientName} on ${domain}`,
        TimeoutSeconds: 300,
      })
    );
    commandId = ssmResp.Command.CommandId;
    await appendLog(deploymentId, `✓ SSM command sent (ID: ${commandId})`);
  } catch (err) {
    throw new Error(`SSM SendCommand failed: ${err.message}`);
  }

  // Poll for completion
  await appendLog(deploymentId, "Waiting for Docker container to start...");
  const ssmResult = await waitForSSMCommand(commandId, process.env.EC2_INSTANCE_ID);

  if (!ssmResult.success) {
    throw new Error(`Docker deployment failed:\n${ssmResult.output}`);
  }

  // Surface the EC2 output lines into the log
  const outputLines = ssmResult.output.split("\n").filter(Boolean);
  for (const line of outputLines) {
    await appendLog(deploymentId, line);
  }
  await appendLog(deploymentId, "✓ Docker container is live on EC2");

  // ── Step 2: Invoke Lambda for post-deploy setup ────────────────────────────
  await appendLog(deploymentId, "Invoking Lambda for post-deploy configuration...");

  const lambdaPayload = JSON.stringify({
    action:      "post-deploy",
    clientName,
    domain,
    image,
    containerId: containerName,
    deploymentId,
  });

  let lambdaResult;
  try {
    lambdaResult = await lambdaClient.send(
      new InvokeCommand({
        FunctionName:   process.env.LAMBDA_FUNCTION_NAME,
        InvocationType: "RequestResponse",      // synchronous
        Payload:        Buffer.from(lambdaPayload),
      })
    );
  } catch (err) {
    throw new Error(`Lambda invocation failed: ${err.message}`);
  }

  // Check Lambda function error
  if (lambdaResult.FunctionError) {
    const errBody = Buffer.from(lambdaResult.Payload).toString("utf8");
    throw new Error(`Lambda returned error: ${errBody}`);
  }

  const lambdaResponse = JSON.parse(Buffer.from(lambdaResult.Payload).toString("utf8"));
  await appendLog(deploymentId, `✓ Lambda executed (status: ${lambdaResult.StatusCode})`);

  if (lambdaResponse?.message) {
    await appendLog(deploymentId, `Lambda: ${lambdaResponse.message}`);
  }

  // ── Step 3: Mark complete ──────────────────────────────────────────────────
  await appendLog(deploymentId, `✓ Deployment complete — https://${domain} is live`);
  await Deployment.findByIdAndUpdate(deploymentId, { status: "completed" });
}

// ─── Worker setup ─────────────────────────────────────────────────────────────
const worker = new Worker(
  "deployments",
  async (job) => {
    await processDeployment(job);
  },
  {
    connection,
    concurrency: 3, // process up to 3 deployments in parallel
  }
);

worker.on("active",    (job) => console.log(`▶ Job ${job.id} started`));
worker.on("completed", (job) => console.log(`✓ Job ${job.id} completed`));

worker.on("failed", async (job, err) => {
  console.error(`✗ Job ${job.id} failed:`, err.message);
  const deploymentId = job?.data?.deploymentId;
  if (deploymentId) {
    await Deployment.findByIdAndUpdate(deploymentId, {
      status: "failed",
      error:  err.message,
      $push:  { logs: `✗ Error: ${err.message}` },
    }).catch(() => {});
  }
});

console.log("✓ Deployment worker is listening for jobs...");
