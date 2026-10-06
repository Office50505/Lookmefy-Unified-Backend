import express from 'express';
import mongoose from 'mongoose';
import Job from '../models/Job.js';
import { requireUser } from './auth.js';
import { jobToClient } from '../utils/jobs.js';

const router = express.Router();

router.get('/:id', requireUser, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Job not found' });
  const job = await Job.findOne({ _id: req.params.id, user: req.user._id }).lean();
  if (!job) return res.status(404).json({ message: 'Job not found' });
  res.json({
    job: jobToClient(job),
    result: job.status === 'succeeded' ? job.result : undefined
  });
});

export default router;
