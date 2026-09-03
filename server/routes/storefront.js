import express from 'express';
import { getStorefrontSetting } from '../models/StorefrontSetting.js';

const router = express.Router();

router.get('/config', async (_req, res, next) => {
  try {
    const setting = await getStorefrontSetting();
    res.setHeader('Cache-Control', 'no-store');
    res.json(setting.toClient());
  } catch (error) {
    next(error);
  }
});

export default router;
