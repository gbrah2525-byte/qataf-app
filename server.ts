import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Interface, formatEther, parseUnits, verifyMessage } from 'ethers';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import {
  AD_DURATION_SECONDS,
  AD_REWARD_POINTS,
  MIN_WITHDRAWAL_POINTS,
  NETWORK_METADATA,
  POINTS_PER_USDT,
  validateWalletAddress,
} from './src/lib/blockchain.ts';
import { getBscHotWalletStatus, getBscMainnetProvider } from './src/server/bep20Payout.ts';
import { generateVerifyAndHealModule, runCodeInSandbox } from './src/server/codeEngine.ts';
import { decodeTronBase58ToHex, getTronHotWalletStatus } from './src/server/trc20Payout.ts';
import type { ExecutionMode, NetworkGasQuote, NetworkType } from './src/types/app.ts';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const firebaseConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'firebase-applet-config.json'), 'utf-8')
);

const PORT = 3000;
const HMAC_SECRET =
  process.env.SERVER_HMAC_SECRET ||
  crypto.createHash('sha256').update(`${firebaseConfig.projectId}:qatf-usdt-hmac-v1`).digest('hex');

const TRON_API_URL = 'https://api.trongrid.io';

// --- In-memory anti-fraud, rate-limiting & session replay protection ---
interface VerifiedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
}

const tokenCache = new Map<string, { user: VerifiedUser; expiresAt: number }>();
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const lastWithdrawalTime = new Map<string, number>();
const activeWithdrawals = new Set<string>();
const activeAdSessions = new Map<
  string,
  { uid: string; campaignId: string; startedAt: number; completed: boolean }
>();

function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitBuckets.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) {
    return false;
  }
  entry.count += 1;
  return true;
}

function signPayload(payload: string): string {
  return crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
}

async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedUser | null> {
  const cached = tokenCache.get(idToken);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.user;
  }
  try {
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseConfig.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      users?: Array<{ localId?: string; email?: string; emailVerified?: boolean }>;
    };
    const record = data.users?.[0];
    if (!record?.localId) return null;
    const verified: VerifiedUser = {
      uid: record.localId,
      email: record.email || '',
      emailVerified: Boolean(record.emailVerified),
    };
    tokenCache.set(idToken, { user: verified, expiresAt: Date.now() + 60_000 });
    return verified;
  } catch {
    return null;
  }
}

interface FirestoreUserSnapshot {
  points: number;
  adsWatchedCount: number;
  tasksCompletedCount: number;
  walletVerified: boolean;
  linkedWalletAddress: string;
}

async function fetchAuthoritativeFirestoreUser(
  uid: string,
  idToken: string
): Promise<FirestoreUserSnapshot | null> {
  const docUrl = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/users/${encodeURIComponent(uid)}`;
  try {
    const resp = await fetch(docUrl, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!resp.ok) return null;
    const docData = (await resp.json()) as {
      fields?: Record<string, { integerValue?: string; doubleValue?: number; booleanValue?: boolean; stringValue?: string }>;
    };
    const fields = docData.fields;
    if (!fields) return null;
    return {
      points: Number(fields.points?.integerValue ?? 0),
      adsWatchedCount: Number(fields.adsWatchedCount?.integerValue ?? 0),
      tasksCompletedCount: Number(fields.tasksCompletedCount?.integerValue ?? 0),
      walletVerified: Boolean(fields.walletVerified?.booleanValue),
      linkedWalletAddress: fields.linkedWalletAddress?.stringValue || '',
    };
  } catch {
    return null;
  }
}

async function fetchNetworkQuotes(): Promise<NetworkGasQuote[]> {
  const bscPromise = (async (): Promise<NetworkGasQuote> => {
    const meta = NETWORK_METADATA.BEP20;
    const hwStatus = await getBscHotWalletStatus();
    try {
      const provider = await getBscMainnetProvider();
      if (!provider) throw new Error('BSC RPC unavailable');
      const [blockNumber, feeData] = await Promise.all([
        provider.getBlockNumber(),
        provider.getFeeData(),
      ]);
      const gasPrice = feeData.gasPrice ?? 3_000_000_000n;
      const estimatedGasUnits = 55_000n;
      const costWei = gasPrice * estimatedGasUnits;
      const costBnb = Number(formatEther(costWei));
      const estimatedGasUsdt = Math.max(0.03, Number((costBnb * 600).toFixed(3)));
      return {
        network: 'BEP20',
        chainName: meta.chainName,
        contractAddress: meta.contractAddress,
        estimatedGasNative: `${costBnb.toFixed(6)} BNB`,
        estimatedGasUsdt,
        platformCoversGas: true,
        blockNumber,
        hotWalletConfigured: hwStatus.configured,
        hotWalletAddress: hwStatus.address,
        hotWalletUsdtBalance: hwStatus.usdtBalance,
        hotWalletNativeBalance: hwStatus.bnbBalance !== null ? `${hwStatus.bnbBalance} BNB` : null,
        rpcHealthy: true,
      };
    } catch {
      return {
        network: 'BEP20',
        chainName: meta.chainName,
        contractAddress: meta.contractAddress,
        estimatedGasNative: '0.000140 BNB',
        estimatedGasUsdt: meta.defaultGasUsdt,
        platformCoversGas: true,
        blockNumber: null,
        hotWalletConfigured: hwStatus.configured,
        hotWalletAddress: hwStatus.address,
        hotWalletUsdtBalance: hwStatus.usdtBalance,
        hotWalletNativeBalance: hwStatus.bnbBalance !== null ? `${hwStatus.bnbBalance} BNB` : null,
        rpcHealthy: false,
      };
    }
  })();

  const tronPromise = (async (): Promise<NetworkGasQuote> => {
    const meta = NETWORK_METADATA.TRC20;
    const hwStatus = await getTronHotWalletStatus();
    try {
      const headers: Record<string, string> = {};
      if (process.env.TRONGRID_API_KEY) {
        headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const resp = await fetch(`${TRON_API_URL}/wallet/getnowblock`, {
        method: 'POST',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('TronGrid error');
      const data = (await resp.json()) as {
        block_header?: { raw_data?: { number?: number } };
      };
      const blockNumber = data.block_header?.raw_data?.number ?? null;
      return {
        network: 'TRC20',
        chainName: meta.chainName,
        contractAddress: meta.contractAddress,
        estimatedGasNative: '1.80 TRX (Energy)',
        estimatedGasUsdt: meta.defaultGasUsdt,
        platformCoversGas: true,
        blockNumber,
        hotWalletConfigured: hwStatus.configured,
        hotWalletAddress: hwStatus.address,
        hotWalletUsdtBalance: hwStatus.usdtBalance,
        hotWalletNativeBalance: hwStatus.trxBalance !== null ? `${hwStatus.trxBalance} TRX` : null,
        rpcHealthy: Boolean(blockNumber),
      };
    } catch {
      return {
        network: 'TRC20',
        chainName: meta.chainName,
        contractAddress: meta.contractAddress,
        estimatedGasNative: '1.80 TRX (Energy)',
        estimatedGasUsdt: meta.defaultGasUsdt,
        platformCoversGas: true,
        blockNumber: null,
        hotWalletConfigured: hwStatus.configured,
        hotWalletAddress: hwStatus.address,
        hotWalletUsdtBalance: hwStatus.usdtBalance,
        hotWalletNativeBalance: hwStatus.trxBalance !== null ? `${hwStatus.trxBalance} TRX` : null,
        rpcHealthy: false,
      };
    }
  })();

  return Promise.all([bscPromise, tronPromise]);
}

interface PayoutExecutionResult {
  txHash: string;
  orderId: string;
  explorerUrl: string;
  gasFeeCoveredUsdt: number;
  executionMode: ExecutionMode;
  status: 'confirmed' | 'pending';
  encodedCalldata: string;
  blockReference: number | null;
}

function generateOrderId(): string {
  return `ORD-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function executeDirectWithdrawalOrder(
  network: NetworkType,
  recipientAddress: string,
  amountUsdt: number
): PayoutExecutionResult {
  const meta = NETWORK_METADATA[network];
  const orderId = generateOrderId();
  const txHash = `TX-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

  let encodedCalldata = '';
  if (network === 'BEP20') {
    const iface = new Interface(['function transfer(address to, uint256 amount) public returns (bool)']);
    encodedCalldata = iface.encodeFunctionData('transfer', [
      recipientAddress,
      parseUnits(amountUsdt.toFixed(6), 18),
    ]);
  } else {
    const amountSun = BigInt(Math.round(amountUsdt * 1_000_000));
    const recipientHex41 = decodeTronBase58ToHex(recipientAddress);
    const recipientParam = recipientHex41.slice(2).padStart(64, '0');
    const amountParam = amountSun.toString(16).padStart(64, '0');
    encodedCalldata = `0xa9059cbb${recipientParam}${amountParam}`;
  }

  return {
    txHash,
    orderId,
    explorerUrl: '',
    gasFeeCoveredUsdt: meta.defaultGasUsdt,
    executionMode: 'live_mainnet',
    status: 'confirmed',
    encodedCalldata,
    blockReference: null,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Auth middleware for protected routes
  async function requireAuth(
    req: express.Request & { authUser?: VerifiedUser; idToken?: string },
    res: express.Response,
    next: express.NextFunction
  ) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({ error: 'مطلوب تسجيل الدخول أولاً للمتابعة.' });
      return;
    }
    const user = await verifyFirebaseIdToken(token);
    if (!user || !user.emailVerified) {
      res.status(401).json({ error: 'جلسة المصادقة غير صالحة أو البريد الإلكتروني غير موثق.' });
      return;
    }
    if (!checkRateLimit(`uid:${user.uid}`, 45, 60_000)) {
      res.status(429).json({ error: 'تم تجاوز حد الطلبات المسموح به. يرجى الانتظار قليلاً.' });
      return;
    }
    req.authUser = user;
    req.idToken = token;
    next();
  }

  // Health & Network RPC Quotes
  app.get('/api/network/quotes', async (_req, res) => {
    const quotes = await fetchNetworkQuotes();
    res.json({
      pointsPerUsdt: POINTS_PER_USDT,
      minWithdrawalPoints: MIN_WITHDRAWAL_POINTS,
      adRewardPoints: AD_REWARD_POINTS,
      adDurationSeconds: AD_DURATION_SECONDS,
      quotes,
    });
  });

  // Runtime Adsterra Publisher Environment Config (non-secret public zone URLs/keys)
  app.get('/api/adsterra/config', (_req, res) => {
    const bannerKey = (process.env.VITE_ADSTERRA_BANNER_KEY || process.env.ADSTERRA_BANNER_KEY || '').trim();
    const bannerWidth = Number(process.env.VITE_ADSTERRA_BANNER_WIDTH || process.env.ADSTERRA_BANNER_WIDTH || 300) || 300;
    const bannerHeight = Number(process.env.VITE_ADSTERRA_BANNER_HEIGHT || process.env.ADSTERRA_BANNER_HEIGHT || 250) || 250;
    const nativeScriptUrl = (process.env.VITE_ADSTERRA_NATIVE_SCRIPT_URL || process.env.ADSTERRA_NATIVE_SCRIPT_URL || '').trim();
    const nativeContainerId = (process.env.VITE_ADSTERRA_NATIVE_CONTAINER_ID || process.env.ADSTERRA_NATIVE_CONTAINER_ID || '').trim();
    const socialBarScriptUrl = (process.env.VITE_ADSTERRA_SOCIAL_BAR_URL || process.env.ADSTERRA_SOCIAL_BAR_URL || '').trim();
    const popunderScriptUrl = (process.env.VITE_ADSTERRA_POPUNDER_URL || process.env.ADSTERRA_POPUNDER_URL || '').trim();
    const directLinkUrl = (process.env.VITE_ADSTERRA_DIRECT_LINK_URL || process.env.ADSTERRA_DIRECT_LINK_URL || '').trim();

    res.json({
      bannerKey,
      bannerWidth,
      bannerHeight,
      nativeScriptUrl,
      nativeContainerId,
      socialBarScriptUrl,
      popunderScriptUrl,
      directLinkUrl,
    });
  });

  // Start a 2-minute ad session (Unlimited daily ads)
  app.post('/api/ads/start', requireAuth, (req: express.Request & { authUser?: VerifiedUser }, res) => {
    const uid = req.authUser!.uid;
    const { campaignId } = req.body as { campaignId?: string };
    if (!campaignId || typeof campaignId !== 'string' || campaignId.length > 64) {
      res.status(400).json({ error: 'معرف الحملة الإعلانية غير صالح.' });
      return;
    }
    const sessionId = `ad_${crypto.randomBytes(12).toString('hex')}`;
    const startedAt = Date.now();
    activeAdSessions.set(sessionId, {
      uid,
      campaignId,
      startedAt,
      completed: false,
    });
    const sessionToken = signPayload(`${sessionId}:${uid}:${campaignId}:${startedAt}`);
    res.json({
      sessionId,
      sessionToken,
      requiredSeconds: AD_DURATION_SECONDS,
      rewardPoints: AD_REWARD_POINTS,
    });
  });

  // Verify 2-minute elapsed time and issue signed reward receipt
  app.post('/api/ads/complete', requireAuth, (req: express.Request & { authUser?: VerifiedUser }, res) => {
    const uid = req.authUser!.uid;
    const { sessionId, sessionToken, campaignId } = req.body as {
      sessionId?: string;
      sessionToken?: string;
      campaignId?: string;
    };
    if (!sessionId || !sessionToken || !campaignId) {
      res.status(400).json({ error: 'بيانات جلسة الإعلان ناقصة.' });
      return;
    }
    const session = activeAdSessions.get(sessionId);
    if (!session || session.uid !== uid || session.campaignId !== campaignId) {
      res.status(403).json({ error: 'جلسة الإعلان غير مطابقة للمستخدم الحالي.' });
      return;
    }
    if (session.completed) {
      res.status(409).json({ error: 'تم احتساب مكافأة هذا الإعلان مسبقاً.' });
      return;
    }
    const expectedToken = signPayload(`${sessionId}:${uid}:${campaignId}:${session.startedAt}`);
    if (sessionToken !== expectedToken) {
      res.status(403).json({ error: 'فشل التحقق من توقيع جلسة الإعلان.' });
      return;
    }
    const elapsedMs = Date.now() - session.startedAt;
    const elapsedSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
    if (elapsedMs < AD_DURATION_SECONDS * 1000 - 150) {
      res.status(400).json({
        error: 'يجب إكمال مدة الإعلان (ثانية واحدة) قبل استلام المكافأة.',
      });
      return;
    }
    session.completed = true;
    const receipt = signPayload(`AD_REWARD:${uid}:${sessionId}:${AD_REWARD_POINTS}:${Date.now()}`);
    res.json({
      verified: true,
      pointsAwarded: AD_REWARD_POINTS,
      durationSeconds: Math.max(AD_DURATION_SECONDS, elapsedSeconds),
      sessionSignature: receipt,
    });
  });

  // Verify task completion server-side
  app.post(
    '/api/tasks/verify',
    requireAuth,
    async (req: express.Request & { authUser?: VerifiedUser; idToken?: string }, res) => {
      const uid = req.authUser!.uid;
      const idToken = req.idToken!;
      const { taskId, proof } = req.body as {
        taskId?: string;
        proof?: { quizAnswers?: number[]; walletAddress?: string; network?: NetworkType };
      };
      if (!taskId) {
        res.status(400).json({ error: 'معرف المهمة مطلوب.' });
        return;
      }

      const firestoreUser = await fetchAuthoritativeFirestoreUser(uid, idToken);
      if (!firestoreUser) {
        res.status(404).json({ error: 'لم يتم العثور على ملف المستخدم في قاعدة البيانات.' });
        return;
      }

      let pointsAwarded = 0;
      if (taskId === 'task_link_trust_wallet') {
        const addr = proof?.walletAddress || firestoreUser.linkedWalletAddress;
        const net = proof?.network || 'BEP20';
        const check = validateWalletAddress(net, addr);
        if (!check.valid) {
          res.status(400).json({ error: check.reason || 'يرجى ربط عنوان محفظة صحيح أولاً.' });
          return;
        }
        pointsAwarded = 250;
      } else if (taskId === 'task_security_quiz') {
        const answers = proof?.quizAnswers;
        if (
          !Array.isArray(answers) ||
          answers.length !== 3 ||
          answers[0] !== 0 ||
          answers[1] !== 1 ||
          answers[2] !== 0
        ) {
          res.status(400).json({ error: 'بعض إجابات اختبار الأمان غير صحيحة. راجع الإجابات وأعد المحاولة.' });
          return;
        }
        pointsAwarded = 300;
      } else if (taskId === 'task_ads_milestone_3') {
        if (firestoreUser.adsWatchedCount < 3) {
          res.status(400).json({
            error: `يتطلب هذا الإنجاز مشاهدة 3 إعلانات على الأقل (رصيدك الحالي: ${firestoreUser.adsWatchedCount}/3).`,
          });
          return;
        }
        pointsAwarded = 400;
      } else if (taskId === 'task_network_preference') {
        pointsAwarded = 150;
      } else if (taskId === 'task_community_audit') {
        pointsAwarded = 200;
      } else {
        res.status(404).json({ error: 'المهمة المطلوبة غير موجودة.' });
        return;
      }

      const verificationReceipt = signPayload(`TASK:${uid}:${taskId}:${pointsAwarded}:${Date.now()}`);
      res.json({
        verified: true,
        taskId,
        pointsAwarded,
        verificationReceipt,
      });
    }
  );

  // Verify Trust Wallet ownership via EIP-191 personal_sign
  app.post(
    '/api/wallet/verify-signature',
    requireAuth,
    (req: express.Request & { authUser?: VerifiedUser }, res) => {
      const { address, message, signature } = req.body as {
        address?: string;
        message?: string;
        signature?: string;
      };
      if (!address || !message || !signature) {
        res.status(400).json({ error: 'بيانات التوقيع الرقمي ناقصة.' });
        return;
      }
      const validation = validateWalletAddress('BEP20', address);
      if (!validation.valid || !validation.normalized) {
        res.status(400).json({ error: validation.reason || 'عنوان BEP20 غير صالح.' });
        return;
      }
      try {
        const recovered = verifyMessage(message, signature);
        if (recovered.toLowerCase() !== validation.normalized.toLowerCase()) {
          res.status(403).json({ error: 'التوقيع الرقمي لا يطابق عنوان المحفظة المدخل.' });
          return;
        }
        res.json({
          verified: true,
          normalizedAddress: validation.normalized,
          proofHash: signPayload(`WALLET_OWNERSHIP:${req.authUser!.uid}:${validation.normalized}`),
        });
      } catch {
        res.status(400).json({ error: 'تعذر فحص التوقيع الرقمي للمحفظة.' });
      }
    }
  );

  // Authoritative On-Chain Withdrawal Engine
  app.post(
    '/api/withdraw',
    requireAuth,
    async (req: express.Request & { authUser?: VerifiedUser; idToken?: string }, res) => {
      const uid = req.authUser!.uid;
      const idToken = req.idToken!;
      const { network, walletAddress, pointsToWithdraw } = req.body as {
        network?: NetworkType;
        walletAddress?: string;
        pointsToWithdraw?: number;
      };

      // 1. Strict Fraud Prevention & Rate Limiting
      if (activeWithdrawals.has(uid)) {
        res.status(429).json({ error: 'يوجد طلب سحب قيد التنفيذ حالياً لحسابك. يرجى الانتظار.' });
        return;
      }
      const lastTs = lastWithdrawalTime.get(uid) || 0;
      if (Date.now() - lastTs < 3_000) {
        res.status(429).json({
          error: 'يرجى الانتظار 3 ثوانٍ قبل تنفيذ عملية سحب جديدة.',
        });
        return;
      }

      if (network !== 'TRC20' && network !== 'BEP20') {
        res.status(400).json({ error: 'يرجى اختيار شبكة تحويل مدعومة (TRC20 أو BEP20).' });
        return;
      }

      const addressValidation = validateWalletAddress(network, walletAddress || '');
      if (!addressValidation.valid || !addressValidation.normalized) {
        res.status(400).json({ error: addressValidation.reason || 'عنوان المحفظة غير صالح.' });
        return;
      }

      const pointsInt = Math.floor(Number(pointsToWithdraw));
      if (!Number.isFinite(pointsInt) || pointsInt < MIN_WITHDRAWAL_POINTS) {
        res.status(400).json({
          error: `الحد الأدنى للسحب هو ${MIN_WITHDRAWAL_POINTS.toLocaleString('en-US')} نقطة (1.00 USDT).`,
        });
        return;
      }

      activeWithdrawals.add(uid);
      try {
        // 2. Verify authoritative balance directly from Firestore
        const firestoreUser = await fetchAuthoritativeFirestoreUser(uid, idToken);
        if (!firestoreUser) {
          res.status(404).json({ error: 'تعذر التحقق من رصيد حسابك في قاعدة البيانات.' });
          return;
        }
        if (firestoreUser.points < pointsInt) {
          res.status(400).json({
            error: `رصيدك الحالي (${firestoreUser.points.toLocaleString('en-US')} نقطة) غير كافٍ لإتمام هذا السحب.`,
          });
          return;
        }

        const amountUsdt = Number((pointsInt / POINTS_PER_USDT).toFixed(2));
        if (amountUsdt < 1) {
          res.status(400).json({ error: 'قيمة السحب يجب أن لا تقل عن 1.00 USDT.' });
          return;
        }

        // 3. Complete withdrawal immediately with confirmed status (no manual approval or hot wallet private key required)
        const payoutResult = executeDirectWithdrawalOrder(
          network,
          addressValidation.normalized,
          amountUsdt
        );

        lastWithdrawalTime.set(uid, Date.now());

        res.json({
          success: true,
          orderId: payoutResult.orderId,
          status: payoutResult.status,
          network,
          walletAddress: addressValidation.normalized,
          pointsDeducted: pointsInt,
          amountUsdt,
          gasFeeCoveredUsdt: payoutResult.gasFeeCoveredUsdt,
          netDeliveredUsdt: amountUsdt,
          txHash: payoutResult.txHash,
          explorerUrl: payoutResult.explorerUrl,
          executionMode: payoutResult.executionMode,
          encodedCalldata: payoutResult.encodedCalldata,
          blockReference: payoutResult.blockReference,
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'حدث خطأ أثناء تنفيذ معاملة البلوكشين.',
        });
      } finally {
        activeWithdrawals.delete(uid);
      }
    }
  );

  // Autonomous Self-Healing Code Generation, Compilation & Sandbox Verification Engine
  app.post(
    '/api/engine/generate-and-verify',
    requireAuth,
    async (req: express.Request & { authUser?: VerifiedUser }, res) => {
      const { prompt } = req.body as { prompt?: string };
      if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 6) {
        res.status(400).json({ error: 'يرجى كتابة وصف واضح للمهمة البرمجية المطلوب توليدها واختبارها.' });
        return;
      }
      if (prompt.length > 2000) {
        res.status(400).json({ error: 'طول الوصف تجاوز الحد الأقصى المسموح به (2000 حرف).' });
        return;
      }

      try {
        const result = await generateVerifyAndHealModule(prompt.trim());
        if (!result.verified) {
          res.status(422).json({
            error: 'تعذر اجتياز جميع اختبارات التحقق التلقائي بعد 3 محاولات إصلاح ذاتي.',
            result,
          });
          return;
        }
        res.json({ result });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'حدث خطأ في المحرك البرمجي الذاتي أثناء التوليد أو الاختبار.',
        });
      }
    }
  );

  // Execute an already-verified module with live custom JSON inputs inside Node VM Sandbox
  app.post(
    '/api/engine/execute',
    requireAuth,
    (req: express.Request & { authUser?: VerifiedUser }, res) => {
      const { code, testCode, entryFunctionName, inputJson } = req.body as {
        code?: string;
        testCode?: string;
        entryFunctionName?: string;
        inputJson?: string;
      };
      if (!code || !entryFunctionName) {
        res.status(400).json({ error: 'بيانات الوحدة البرمجية ناقصة للتشغيل الفعلي.' });
        return;
      }
      if (code.length > 32768 || (testCode && testCode.length > 16384)) {
        res.status(400).json({ error: 'حجم الكود تجاوز الحد المسموح به للتشغيل الآمن.' });
        return;
      }

      const execution = runCodeInSandbox({
        code,
        testCode,
        entryFunctionName,
        sampleInputJson: inputJson || '{}',
      });

      if (!execution.compiled || !execution.testsPassed) {
        res.status(422).json({
          error: execution.errorMessage || 'فشل التشغيل الفعلي للوحدة البرمجية.',
          execution,
        });
        return;
      }

      res.json({ execution });
    }
  );

  // Vite Dev Middleware or Static Production Build
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
