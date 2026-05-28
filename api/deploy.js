import mongoose from "mongoose";
import { Queue } from "bullmq";
import IORedis from "ioredis";

// ─── MongoDB connection (reuse across warm invocations) ───────────────────────
let isMongoConnected = false;

async function connectMongo() {
  if (isMongoConnected) return;
  await mongoose.connect(process.env.MONGO_URI);
  isMongoConnected = true;
}

// ─── Deployment schema ────────────────────────────────────────────────────────
const deploymentSchema = new mongoose.Schema(
  {
    clientName: String,
    domain:     String,
    image:      String,
    status:     { type: String, default: "pending" },
    jobId:      String,
    logs:       { type: [String], default: [] },
    error:      String,
  },
  { timestamps: true }
);

const Deployment =
  mongoose.models.Deployment || mongoose.model("Deployment", deploymentSchema);

// ─── Redis / BullMQ ───────────────────────────────────────────────────────────
function getQueue() {
  const connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    tls: process.env.REDIS_URL?.startsWith("rediss://") ? {} : undefined,
  });
  return new Queue("deployments", { connection });
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  await connectMongo();

  const url = req.url || "";

  // ── GET /api/deployments ──────────────────────────────────────────────────
  if (req.method === "GET" && !url.includes("/status/")) {
    const deployments = await Deployment.find().sort({ createdAt: -1 }).lean();
    return res.status(200).json(deployments);
  }

  // ── GET /api/status/:id ───────────────────────────────────────────────────
  if (req.method === "GET" && url.includes("/status/")) {
    const id = url.split("/status/")[1];
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid ID" });
    }
    const deployment = await Deployment.findById(id).lean();
    if (!deployment) return res.status(404).json({ error: "Not found" });
    return res.status(200).json(deployment);
  }

  // ── POST /api/deploy ──────────────────────────────────────────────────────
  if (req.method === "POST") {
    const { clientName, domain, image } = req.body;
    if (!clientName || !domain || !image) {
      return res.status(400).json({ error: "clientName, domain, and image are required." });
    }

    const deployment = await Deployment.create({ clientName, domain, image });

    const queue = getQueue();
    const job = await queue.add("run-deployment", {
      deploymentId: deployment._id.toString(),
      clientName,
      domain,
      image,
    });

    deployment.jobId = job.id;
    await deployment.save();

    return res.status(200).json({
      message: "Deployment queued.",
      deploymentId: deployment._id,
      jobId: job.id,
    });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
