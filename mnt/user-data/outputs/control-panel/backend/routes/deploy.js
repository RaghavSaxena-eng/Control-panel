import { Router } from "express";
import mongoose from "mongoose";
import Deployment from "../models/Deployment.js";
import { deployQueue } from "../config/queue.js";

const router = Router();

/**
 * POST /api/deploy
 * Accepts: { clientName, domain, image }
 * Saves to MongoDB as "pending", pushes job to BullMQ, returns 200 immediately.
 */
router.post("/deploy", async (req, res) => {
  const { clientName, domain, image } = req.body;

  if (!clientName || !domain || !image) {
    return res.status(400).json({ error: "clientName, domain, and image are required." });
  }

  try {
    // 1. Persist deployment record
    const deployment = await Deployment.create({ clientName, domain, image, status: "pending" });

    // 2. Push job to BullMQ queue
    const job = await deployQueue.add("run-deployment", {
      deploymentId: deployment._id.toString(),
      clientName,
      domain,
      image,
    });

    // 3. Save jobId back to the record
    deployment.jobId = job.id;
    await deployment.save();

    return res.status(200).json({
      message: "Deployment queued successfully.",
      deploymentId: deployment._id,
      jobId: job.id,
    });
  } catch (err) {
    console.error("POST /api/deploy error:", err);
    return res.status(500).json({ error: "Failed to queue deployment." });
  }
});

/**
 * GET /api/status/:id
 * Returns current deployment status + logs from MongoDB.
 */
router.get("/status/:id", async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid deployment ID." });
  }

  try {
    const deployment = await Deployment.findById(id).lean();
    if (!deployment) return res.status(404).json({ error: "Deployment not found." });

    return res.json({
      _id:        deployment._id,
      clientName: deployment.clientName,
      domain:     deployment.domain,
      image:      deployment.image,
      status:     deployment.status,
      jobId:      deployment.jobId,
      logs:       deployment.logs,
      error:      deployment.error,
      createdAt:  deployment.createdAt,
      updatedAt:  deployment.updatedAt,
    });
  } catch (err) {
    console.error("GET /api/status error:", err);
    return res.status(500).json({ error: "Failed to fetch status." });
  }
});

/**
 * GET /api/deployments
 * Returns all deployments, most recent first.
 */
router.get("/deployments", async (req, res) => {
  try {
    const deployments = await Deployment.find().sort({ createdAt: -1 }).lean();
    return res.json(deployments);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch deployments." });
  }
});

export default router;
