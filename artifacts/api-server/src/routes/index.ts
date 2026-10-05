import { Router, type IRouter } from "express";
import healthRouter from "./health";
import nestRouter from "./nest";

const router: IRouter = Router();

router.use(healthRouter);
router.use(nestRouter);

export default router;
