import mongoose from "mongoose";

const deploymentSchema = new mongoose.Schema(
  {
    clientName: { type: String, required: true, trim: true },
    domain:     { type: String, required: true, trim: true },
    image:      { type: String, required: true, trim: true },
    status:     {
      type: String,
      enum: ["pending", "running", "completed", "failed"],
      default: "pending",
    },
    jobId:      { type: String },
    logs:       { type: [String], default: [] },
    error:      { type: String },
  },
  { timestamps: true }
);

export default mongoose.model("Deployment", deploymentSchema);
