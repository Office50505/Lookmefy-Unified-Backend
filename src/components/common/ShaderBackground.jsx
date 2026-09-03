import { useEffect, useRef } from 'react';

const CHANGE_EVENT_TIME = 0.32;
const CAMERA_Z = -400;
const CAMERA_TRAVEL_DISTANCE = 3400;
const START_DOT_Y_OFFSET = 28;
const VIEW_ZOOM = 100;
const NUMBER_OF_STARS = 5000;
const TRAIL_LENGTH = 80;
const PENDING_SETTLE_MS = 18000;
const HOLD_PROGRESS = 0.72;
const FINISH_DURATION_MS = 1800;
const HOLD_MOTION_MS = 5200;

class Vector2D {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}

class Vector3D {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
}

function createSeededRandom(seed = 1234) {
  let current = seed;
  return () => {
    current = (current * 9301 + 49297) % 233280;
    return current / 233280;
  };
}

function randomBetween(random, min, max) {
  return min + random() * (max - min);
}

function ease(progress, power) {
  if (progress < 0.5) return 0.5 * Math.pow(2 * progress, power);
  return 1 - 0.5 * Math.pow(2 * (1 - progress), power);
}

function easeOutElastic(value) {
  const c4 = (2 * Math.PI) / 4.5;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return Math.pow(2, -8 * value) * Math.sin((value * 8 - 0.75) * c4) + 1;
}

function mapRange(value, start1, stop1, start2, stop2) {
  return start2 + (stop2 - start2) * ((value - start1) / (stop1 - start1));
}

function constrain(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function lerp(start, end, progress) {
  return start * (1 - progress) + end * progress;
}

function easeOutCubic(progress) {
  return 1 - Math.pow(1 - constrain(progress, 0, 1), 3);
}

function spiralPath(progress) {
  const p = ease(constrain(1.2 * progress, 0, 1), 1.8);
  const theta = 2 * Math.PI * 6 * Math.sqrt(p);
  const radius = 170 * Math.sqrt(p);
  return new Vector2D(
    radius * Math.cos(theta),
    radius * Math.sin(theta) + START_DOT_Y_OFFSET
  );
}

function rotate(v1, v2, progress, orientation) {
  const middle = new Vector2D((v1.x + v2.x) / 2, (v1.y + v2.y) / 2);
  const dx = v1.x - middle.x;
  const dy = v1.y - middle.y;
  const angle = Math.atan2(dy, dx);
  const direction = orientation ? -1 : 1;
  const radius = Math.sqrt(dx * dx + dy * dy);
  const bounce = Math.sin(progress * Math.PI) * 0.05 * (1 - progress);
  const elastic = easeOutElastic(progress);

  return new Vector2D(
    middle.x + radius * (1 + bounce) * Math.cos(angle + direction * Math.PI * elastic),
    middle.y + radius * (1 + bounce) * Math.sin(angle + direction * Math.PI * elastic)
  );
}

class Star {
  constructor(random) {
    this.angle = random() * Math.PI * 2;
    this.distance = 30 * random() + 15;
    this.rotationDirection = random() > 0.5 ? 1 : -1;
    this.expansionRate = 1.2 + random() * 0.8;
    this.finalScale = 0.7 + random() * 0.6;
    this.dx = this.distance * Math.cos(this.angle);
    this.dy = this.distance * Math.sin(this.angle);
    this.spiralLocation = (1 - Math.pow(1 - random(), 3)) / 1.3;
    this.z = randomBetween(random, 0.5 * CAMERA_Z, CAMERA_TRAVEL_DISTANCE + CAMERA_Z);
    this.z = lerp(this.z, CAMERA_TRAVEL_DISTANCE / 2, 0.3 * this.spiralLocation);
    this.strokeWeightFactor = Math.pow(random(), 2);
  }

  render(progress, renderer, holdMotion = 0) {
    const spiralPosition = spiralPath(this.spiralLocation);
    const offsetProgress = progress - this.spiralLocation;
    if (offsetProgress <= 0) return;

    const displacementProgress = constrain(4 * offsetProgress, 0, 1);
    const linearEasing = displacementProgress;
    const elasticEasing = easeOutElastic(displacementProgress);
    const powerEasing = Math.pow(displacementProgress, 2);
    let easing;

    if (displacementProgress < 0.3) {
      easing = lerp(linearEasing, powerEasing, displacementProgress / 0.3);
    } else if (displacementProgress < 0.7) {
      easing = lerp(powerEasing, elasticEasing, (displacementProgress - 0.3) / 0.4);
    } else {
      easing = elasticEasing;
    }

    let screenX;
    let screenY;
    if (displacementProgress < 0.3) {
      screenX = lerp(spiralPosition.x, spiralPosition.x + this.dx * 0.3, easing / 0.3);
      screenY = lerp(spiralPosition.y, spiralPosition.y + this.dy * 0.3, easing / 0.3);
    } else if (displacementProgress < 0.7) {
      const midProgress = (displacementProgress - 0.3) / 0.4;
      const curveStrength = Math.sin(midProgress * Math.PI) * this.rotationDirection * 1.5;
      const baseX = spiralPosition.x + this.dx * 0.3;
      const baseY = spiralPosition.y + this.dy * 0.3;
      const targetX = spiralPosition.x + this.dx * 0.7;
      const targetY = spiralPosition.y + this.dy * 0.7;
      const perpX = -this.dy * 0.4 * curveStrength;
      const perpY = this.dx * 0.4 * curveStrength;
      screenX = lerp(baseX, targetX, midProgress) + perpX * midProgress;
      screenY = lerp(baseY, targetY, midProgress) + perpY * midProgress;
    } else {
      const finalProgress = (displacementProgress - 0.7) / 0.3;
      const baseX = spiralPosition.x + this.dx * 0.7;
      const baseY = spiralPosition.y + this.dy * 0.7;
      const pulse = holdMotion ? 1 + Math.sin((holdMotion + this.angle) * Math.PI * 2) * 0.12 : 1;
      const targetDistance = this.distance * this.expansionRate * 1.5 * pulse;
      const spiralTurns = 1.2 * this.rotationDirection + holdMotion * 0.85;
      const spiralAngle = this.angle + spiralTurns * finalProgress * Math.PI;
      const targetX = spiralPosition.x + targetDistance * Math.cos(spiralAngle);
      const targetY = spiralPosition.y + targetDistance * Math.sin(spiralAngle);
      screenX = lerp(baseX, targetX, finalProgress);
      screenY = lerp(baseY, targetY, finalProgress);
    }

    const vx = (this.z - CAMERA_Z) * screenX / VIEW_ZOOM;
    const vy = (this.z - CAMERA_Z) * screenY / VIEW_ZOOM;
    let sizeMultiplier = 1;
    if (displacementProgress < 0.6) {
      sizeMultiplier = 1 + displacementProgress * 0.2;
    } else {
      const sizeProgress = (displacementProgress - 0.6) / 0.4;
      sizeMultiplier = 1.2 * (1 - sizeProgress) + this.finalScale * sizeProgress;
    }

    const twinkle = holdMotion ? 0.78 + 0.28 * Math.sin((holdMotion * 2.4 + this.angle) * Math.PI * 2) : 1;
    renderer.showProjectedDot(new Vector3D(vx, vy, this.z), 8.5 * this.strokeWeightFactor * sizeMultiplier * twinkle);
  }
}

function createStars() {
  const random = createSeededRandom();
  return Array.from({ length: NUMBER_OF_STARS }, () => new Star(random));
}

export default function ShaderBackground({ className = '', complete = false, onComplete }) {
  const canvasRef = useRef(null);
  const onCompleteRef = useRef(onComplete);
  const completeRef = useRef(complete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    completeRef.current = complete;
  }, [complete]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: false });
    if (!canvas || !ctx) return undefined;

    const stars = createStars();
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let width = 1;
    let height = 1;
    let drawSize = 1;
    let disposed = false;
    let completed = false;
    let holdStartedAt = 0;
    let finishStartedAt = 0;
    let finishStartProgress = 0;
    let finishHoldMotion = 0;
    const startedAt = performance.now();

    const renderer = {
      time: 0,
      motionTime: 0,
      showProjectedDot(position, sizeFactor) {
        const t2 = constrain(mapRange(this.time, CHANGE_EVENT_TIME, 1, 0, 1), 0, 1);
        const newCameraZ = CAMERA_Z + ease(Math.pow(t2, 1.2), 1.8) * CAMERA_TRAVEL_DISTANCE;
        if (position.z <= newCameraZ) return;

        const dotDepthFromCamera = position.z - newCameraZ;
        const x = VIEW_ZOOM * position.x / dotDepthFromCamera;
        const y = VIEW_ZOOM * position.y / dotDepthFromCamera;
        const strokeWidth = 400 * sizeFactor / dotDepthFromCamera;

        ctx.lineWidth = strokeWidth;
        ctx.beginPath();
        ctx.arc(x, y, 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      drawSize = Math.max(width, height);
      canvas.width = Math.round(drawSize * dpr);
      canvas.height = Math.round(drawSize * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const drawTrail = (t1, holdMotion = 0) => {
      for (let i = 0; i < TRAIL_LENGTH; i += 1) {
        const factor = mapRange(i, 0, TRAIL_LENGTH, 1.1, 0.1);
        const holdPulse = holdMotion ? 0.82 + 0.22 * Math.sin((holdMotion * 1.7 + i * 0.013) * Math.PI * 2) : 1;
        const strokeWidth = (1.3 * (1 - t1) + 3 * Math.sin(Math.PI * t1)) * factor * holdPulse;
        const pathTime = t1 - 0.00015 * i + holdMotion * 0.075;
        const position = spiralPath(pathTime);
        const rotated = rotate(
          position,
          new Vector2D(position.x + 5, position.y + 5),
          Math.sin((renderer.motionTime + holdMotion) * Math.PI * 2) * 0.5 + 0.5,
          i % 2 === 0
        );

        ctx.lineWidth = strokeWidth;
        ctx.beginPath();
        ctx.arc(rotated.x, rotated.y, strokeWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const drawStartDot = () => {
      if (renderer.time <= CHANGE_EVENT_TIME) return;
      const dy = CAMERA_Z * START_DOT_Y_OFFSET / VIEW_ZOOM;
      renderer.showProjectedDot(new Vector3D(0, dy, CAMERA_TRAVEL_DISTANCE), 2.5);
    };

    const drawCompletionBloom = (finishing) => {
      const bloomProgress = constrain(mapRange(renderer.time, 0.58, 0.86, 0, 1), 0, 1);
      const spreadProgress = finishing ? constrain(mapRange(renderer.time, 0.74, 1, 0, 1), 0, 1) : 0;
      if (bloomProgress <= 0 && spreadProgress <= 0) return;

      const centerX = drawSize / 2;
      const centerY = drawSize / 2;
      const bloomRadius = lerp(12, drawSize * 0.78, easeOutCubic(bloomProgress));
      const bloom = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, bloomRadius);
      bloom.addColorStop(0, `rgba(255, 255, 255, ${0.88 * (1 - spreadProgress * 0.2)})`);
      bloom.addColorStop(0.38, `rgba(236, 236, 232, ${0.55 * (1 - spreadProgress * 0.15)})`);
      bloom.addColorStop(0.72, `rgba(190, 190, 184, ${0.22 * (1 - spreadProgress)})`);
      bloom.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = bloom;
      ctx.fillRect(0, 0, drawSize, drawSize);
      ctx.restore();

      if (spreadProgress > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = easeOutCubic(spreadProgress) * 0.96;
        ctx.fillStyle = '#eeeeec';
        ctx.fillRect(0, 0, drawSize, drawSize);
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(255, 255, 255, ${0.18 * (1 - spreadProgress)})`;
        ctx.beginPath();
        ctx.arc(centerX, centerY, lerp(drawSize * 0.28, drawSize * 0.95, easeOutCubic(spreadProgress)), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    };

    const render = (now) => {
      if (disposed) return;
      const pendingElapsed = now - startedAt;
      const pendingProgress = Math.min(HOLD_PROGRESS, HOLD_PROGRESS * (pendingElapsed / PENDING_SETTLE_MS));
      const pendingTimeline = constrain(pendingProgress, 0, HOLD_PROGRESS);
      const reachedHold = pendingTimeline >= HOLD_PROGRESS;
      const shouldFinish = reduceMotion || completeRef.current;

      if (reachedHold && !holdStartedAt) holdStartedAt = now;
      const currentHoldMotion = reachedHold && holdStartedAt ? ((now - holdStartedAt) % HOLD_MOTION_MS) / HOLD_MOTION_MS : 0;

      if (shouldFinish && !finishStartedAt) {
        finishStartedAt = now;
        finishStartProgress = reduceMotion ? 1 : constrain(pendingTimeline, 0.08, HOLD_PROGRESS);
        finishHoldMotion = currentHoldMotion;
      }

      if (finishStartedAt) {
        const finishProgress = reduceMotion ? 1 : constrain((now - finishStartedAt) / FINISH_DURATION_MS, 0, 1);
        renderer.time = lerp(finishStartProgress, 1, finishProgress);
      } else {
        renderer.time = pendingTimeline;
      }

      const holdMotion = finishStartedAt ? finishHoldMotion : currentHoldMotion;
      renderer.motionTime = reduceMotion ? renderer.time : holdMotion;

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, drawSize, drawSize);

      ctx.save();
      ctx.translate(drawSize / 2, drawSize / 2);
      const t1 = constrain(mapRange(renderer.time, 0, CHANGE_EVENT_TIME + 0.25, 0, 1), 0, 1);
      const t2 = constrain(mapRange(renderer.time, CHANGE_EVENT_TIME, 1, 0, 1), 0, 1);
      ctx.rotate(-Math.PI * ease(t2, 2.7) - holdMotion * Math.PI * 2);

      ctx.fillStyle = 'white';
      drawTrail(t1, holdMotion);
      stars.forEach((star) => star.render(t1, renderer, holdMotion));
      drawStartDot();
      ctx.restore();
      drawCompletionBloom(Boolean(finishStartedAt));

      if (renderer.time >= 1) {
        if (!completed) {
          completed = true;
          onCompleteRef.current?.();
        }
        return;
      }

      frame = window.requestAnimationFrame(render);
    };

    resize();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    window.addEventListener('resize', resize);
    frame = window.requestAnimationFrame(render);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
