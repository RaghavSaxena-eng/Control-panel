import { Queue } from "bullmq";
import IORedis from "ioredis";

// Shared Redis connection config
export const redisConnection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  maxRetriesPerRequest: null, // Required by BullMQ
});

// The deployment queue
export const deployQueue = new Queue("deployments", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,             // retry once on failure
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,   // keep last 100 completed jobs
    removeOnFail: 200,
  },
});
