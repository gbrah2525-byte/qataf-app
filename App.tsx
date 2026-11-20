import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  ArrowLeftRight,
  CheckCircle2,
  Coins,
  Cpu,
  History,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Play,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AdPlayerModal } from './components/AdPlayerModal.tsx';
import {
  AdsterraAdUnit,
  getEffectiveAdsterraConfig,
  type RuntimeAdsterraEnvInput,
} from './components/AdsterraAdUnit.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { HistoryView } from './components/HistoryView.tsx';
import { SelfEngineView } from './components/SelfEngineView.tsx';
import { TasksAndAdsView } from './components/TasksAndAdsView.tsx';
import { WalletWithdrawView, type WithdrawalReceiptPayload } from './components/WalletWithdrawView.tsx';
import { AD_CAMPAIGNS } from './data/catalog.ts';
import {
  AD_REWARD_POINTS,
  MIN_WITHDRAWAL_POINTS,
  NETWORK_METADATA,
  POINTS_PER_USDT,
  formatNumberAr,
  pointsToUsdt,
} from './lib/blockchain.ts';
import {
  OperationType,
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  testFirestoreConnection,
} from './lib/firebase.ts';
import type {
  AdCampaign,
  AdRewardLog,
  AdsterraConfig,
  EngineGeneratedModuleResult,
  EngineModuleRecord,
  NetworkGasQuote,
  NetworkType,
  TaskCompletion,
  TaskDefinition,
  UserProfile,
  WithdrawalRequest,
  WithdrawalTx,
} from './types/app.ts';

type ActiveTab = 'home' | 'earn' | 'wallet' | 'history' | 'engine';

const ADMIN_EMAIL = 'gbrah2525@gmail.com';

function generateSafeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`.replace(/[^a-zA-Z0-9_-]/g, '');
}

function QatfApp() {
  const [authReady, setAuthReady] = useState(false);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [idToken, setIdToken] = useState<string>('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [withdrawals, setWithdrawals] = useState<WithdrawalTx[]>([]);
  const [adLogs, setAdLogs] = useState<AdRewardLog[]>([]);
  const [taskCompletions, setTaskCompletions] = useState<TaskCompletion[]>([]);
  const [adminRequests, setAdminRequests] = useState<WithdrawalRequest[]>([]);
  const [engineModules, setEngineModules] = useState<EngineModuleRecord[]>([]);
  const [firestoreAdsterraConfig, setFirestoreAdsterraConfig] = useState<AdsterraConfig | null>(null);
  const [runtimeEnvAdsterra, setRuntimeEnvAdsterra] = useState<RuntimeAdsterraEnvInput | null>(null);
  const [quotes, setQuotes] = useState<NetworkGasQuote[]>([]);

  const [activeTab, setActiveTab] = useState<ActiveTab>('home');
  const [activeAdCampaign, setActiveAdCampaign] = useState<AdCampaign | null>(null);

  const effectiveAdsterraConfig = useMemo(
    () => getEffectiveAdsterraConfig(firestoreAdsterraConfig, runtimeEnvAdsterra),
    [firestoreAdsterraConfig, runtimeEnvAdsterra]
  );

  useEffect(() => {
    testFirestoreConnection();
  }, []);

  async function refreshNetworkQuotes() {
    try {
      const res = await fetch('/api/network/quotes');
      const data = (await res.json()) as { quotes?: NetworkGasQuote[] };
      if (Array.isArray(data.quotes)) {
        setQuotes(data.quotes);
      }
    } catch {
      // Silent fallback to NETWORK_METADATA defaults
    }
  }

  useEffect(() => {
    refreshNetworkQuotes();
    fetch('/api/adsterra/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: RuntimeAdsterraEnvInput | null) => {
        if (data) setRuntimeEnvAdsterra(data);
      })
      .catch(() => {
        // Fallback to Vite build-time env vars only
      });
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setAuthUser(user);
      if (user) {
        try {
          const token = await user.getIdToken();
          setIdToken(token);
        } catch {
          setIdToken('');
        }
      } else {
        setIdToken('');
        setProfile(null);
        setWithdrawals([]);
        setAdLogs([]);
        setTaskCompletions([]);
        setEngineModules([]);
        setFirestoreAdsterraConfig(null);
      }
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // Subscribe to user profile & subcollections once authenticated
  useEffect(() => {
    if (!authReady || !authUser || !authUser.emailVerified) return;

    const uid = authUser.uid;
    const userDocRef = doc(db, 'users', uid);

    const unsubProfile = onSnapshot(
      userDocRef,
      async (snapshot) => {
        if (!snapshot.exists()) {
          const initialProfile = {
            uid,
            displayName: (authUser.displayName || 'مستخدم قطف').slice(0, 100),
            email: (authUser.email || 'user@example.com').slice(0, 150),
            points: 0,
            totalEarnedPoints: 0,
            totalWithdrawnUsdt: 0,
            adsWatchedCount: 0,
            tasksCompletedCount: 0,
            linkedWalletAddress: '',
            linkedNetwork: 'BEP20' as NetworkType,
            walletVerified: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          };
          try {
            await setDoc(userDocRef, initialProfile);
          } catch (err) {
            handleFirestoreError(err, OperationType.CREATE, `users/${uid}`);
          }
          return;
        }
        setProfile(snapshot.data() as UserProfile);
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, `users/${uid}`);
      }
    );

    const getTimestampMs = (ts: unknown): number => {
      if (ts && typeof ts === 'object' && 'toMillis' in ts && typeof (ts as { toMillis: () => number }).toMillis === 'function') {
        return (ts as { toMillis: () => number }).toMillis();
      }
      if (ts && typeof ts === 'object' && 'seconds' in ts && typeof (ts as { seconds: number }).seconds === 'number') {
        return (ts as { seconds: number }).seconds * 1000;
      }
      return 0;
    };

    const withdrawalsRef = collection(db, 'users', uid, 'withdrawals');
    const unsubWithdrawals = onSnapshot(
      query(withdrawalsRef, where('userId', '==', uid), limit(50)),
      (snap) => {
        const items = snap.docs
          .map((d) => d.data() as WithdrawalTx)
          .sort((a, b) => getTimestampMs(b.createdAt) - getTimestampMs(a.createdAt));
        setWithdrawals(items);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, `users/${uid}/withdrawals`);
      }
    );

    const adLogsRef = collection(db, 'users', uid, 'adLogs');
    const unsubAds = onSnapshot(
      query(adLogsRef, where('userId', '==', uid), limit(50)),
      (snap) => {
        const items = snap.docs
          .map((d) => d.data() as AdRewardLog)
          .sort((a, b) => getTimestampMs(b.completedAt) - getTimestampMs(a.completedAt));
        setAdLogs(items);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, `users/${uid}/adLogs`);
      }
    );

    const tasksRef = collection(db, 'users', uid, 'taskCompletions');
    const unsubTasks = onSnapshot(
      query(tasksRef, where('userId', '==', uid), limit(50)),
      (snap) => {
        const items = snap.docs
          .map((d) => d.data() as TaskCompletion)
          .sort((a, b) => getTimestampMs(b.completedAt) - getTimestampMs(a.completedAt));
        setTaskCompletions(items);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, `users/${uid}/taskCompletions`);
      }
    );

    const engineModulesRef = collection(db, 'users', uid, 'engine_modules');
    const unsubEngineModules = onSnapshot(
      query(engineModulesRef, where('userId', '==', uid), limit(30)),
      (snap) => {
        const items = snap.docs
          .map((d) => d.data() as EngineModuleRecord)
          .sort((a, b) => getTimestampMs(b.createdAt) - getTimestampMs(a.createdAt));
        setEngineModules(items);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, `users/${uid}/engine_modules`);
      }
    );

    const adsterraDocRef = doc(db, 'app_settings', 'adsterra_config');
    const unsubAdsterra = onSnapshot(
      adsterraDocRef,
      (snap) => {
        if (snap.exists()) {
          setFirestoreAdsterraConfig(snap.data() as AdsterraConfig);
        } else {
          setFirestoreAdsterraConfig(null);
        }
      },
      () => {
        // Ignore if doc hasn't been created yet or user lacks permission
      }
    );

    let unsubAdminRequests: (() => void) | null = null;
    if (authUser.email === ADMIN_EMAIL) {
      const reqsRef = collection(db, 'withdrawal_requests');
      unsubAdminRequests = onSnapshot(
        query(reqsRef, limit(50)),
        (snap) => {
          const items = snap.docs
            .map((d) => d.data() as WithdrawalRequest)
            .sort((a, b) => getTimestampMs(b.createdAt) - getTimestampMs(a.createdAt));
          setAdminRequests(items);
        },
        (error) => {
          handleFirestoreError(error, OperationType.LIST, 'withdrawal_requests');
        }
      );
    } else {
      setAdminRequests([]);
    }

    return () => {
      unsubProfile();
      unsubWithdrawals();
      unsubAds();
      unsubTasks();
      unsubEngineModules();
      unsubAdsterra();
      if (unsubAdminRequests) unsubAdminRequests();
    };
  }, [authReady, authUser]);

  async function refreshFreshToken(): Promise<string> {
    if (!auth.currentUser) return '';
    const token = await auth.currentUser.getIdToken(true);
    setIdToken(token);
    return token;
  }

  async function handleGoogleSignIn() {
    setSigningIn(true);
    setAuthError(null);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      if (!cred.user.emailVerified) {
        setAuthError('يرجى استخدام حساب Google موثق البريد الإلكتروني للمتابعة.');
      } else {
        const token = await cred.user.getIdToken();
        setIdToken(token);
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'تعذر إتمام تسجيل الدخول عبر Google.');
    } finally {
      setSigningIn(false);
    }
  }

  async function handleSignOut() {
    await signOut(auth);
    setActiveTab('home');
  }

  async function handleAdRewardClaimed(payload: {
    campaign: AdCampaign;
    durationSeconds: number;
    pointsAwarded: number;
    sessionSignature: string;
  }) {
    if (!authUser || !profile) return;
    const uid = authUser.uid;
    const logId = generateSafeId('adlog');
    const batch = writeBatch(db);

    batch.set(doc(db, 'users', uid, 'adLogs', logId), {
      id: logId,
      userId: uid,
      adCampaignId: payload.campaign.id,
      adTitle: payload.campaign.title.slice(0, 140),
      durationSeconds: payload.durationSeconds,
      pointsAwarded: payload.pointsAwarded,
      sessionSignature: payload.sessionSignature.slice(0, 256),
      completedAt: serverTimestamp(),
    });

    batch.update(doc(db, 'users', uid), {
      points: profile.points + payload.pointsAwarded,
      totalEarnedPoints: profile.totalEarnedPoints + payload.pointsAwarded,
      adsWatchedCount: profile.adsWatchedCount + 1,
      updatedAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${uid}/adLogs/${logId}`);
    }
  }

  async function handleCompleteTask(task: TaskDefinition, verificationReceipt: string) {
    if (!authUser || !profile) return;
    const uid = authUser.uid;
    const completionId = generateSafeId('task');
    const batch = writeBatch(db);

    batch.set(doc(db, 'users', uid, 'taskCompletions', completionId), {
      id: completionId,
      userId: uid,
      taskId: task.id,
      taskTitle: task.title.slice(0, 140),
      pointsAwarded: task.pointsReward,
      verificationReceipt: verificationReceipt.slice(0, 256),
      completedAt: serverTimestamp(),
    });

    batch.update(doc(db, 'users', uid), {
      points: profile.points + task.pointsReward,
      totalEarnedPoints: profile.totalEarnedPoints + task.pointsReward,
      tasksCompletedCount: profile.tasksCompletedCount + 1,
      updatedAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${uid}/taskCompletions/${completionId}`);
    }
  }

  async function handleSaveLinkedWallet(
    address: string,
    network: NetworkType,
    verified: boolean
  ) {
    if (!authUser) return;
    const uid = authUser.uid;
    try {
      await updateDoc(doc(db, 'users', uid), {
        linkedWalletAddress: address,
        linkedNetwork: network,
        walletVerified: verified,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${uid}`);
    }
  }

  async function handleRecordWithdrawal(receipt: WithdrawalReceiptPayload) {
    if (!authUser || !profile) return;
    const uid = authUser.uid;
    const txDocId = receipt.orderId || generateSafeId('wd');
    const batch = writeBatch(db);

    batch.set(doc(db, 'users', uid, 'withdrawals', txDocId), {
      id: txDocId,
      userId: uid,
      orderId: receipt.orderId,
      network: receipt.network,
      walletAddress: receipt.walletAddress,
      pointsDeducted: receipt.pointsDeducted,
      amountUsdt: receipt.amountUsdt,
      gasFeeCoveredUsdt: receipt.gasFeeCoveredUsdt,
      netDeliveredUsdt: receipt.netDeliveredUsdt,
      txHash: receipt.txHash,
      explorerUrl: receipt.explorerUrl,
      executionMode: receipt.executionMode,
      status: receipt.status,
      createdAt: serverTimestamp(),
    });

    batch.set(doc(db, 'withdrawal_requests', txDocId), {
      id: txDocId,
      orderId: receipt.orderId,
      userId: uid,
      userEmail: profile.email,
      walletAddress: receipt.walletAddress,
      network: receipt.network,
      pointsDeducted: receipt.pointsDeducted,
      usdtAmount: receipt.netDeliveredUsdt,
      txHash: receipt.status === 'confirmed' ? receipt.txHash : '',
      status: receipt.status,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.update(doc(db, 'users', uid), {
      points: Math.max(0, profile.points - receipt.pointsDeducted),
      totalWithdrawnUsdt: Number((profile.totalWithdrawnUsdt + receipt.netDeliveredUsdt).toFixed(2)),
      updatedAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `withdrawal_requests/${txDocId}`);
    }
  }

  async function handleAdminConfirmRequest(req: WithdrawalRequest, txHash: string) {
    if (!authUser || authUser.email !== ADMIN_EMAIL) return;
    const meta = NETWORK_METADATA[req.network];
    const batch = writeBatch(db);

    batch.update(doc(db, 'withdrawal_requests', req.id), {
      status: 'confirmed',
      txHash,
      updatedAt: serverTimestamp(),
    });

    batch.update(doc(db, 'users', req.userId, 'withdrawals', req.id), {
      status: 'confirmed',
      txHash,
      explorerUrl: `${meta.explorerBaseTx}${txHash}`,
      executionMode: 'live_mainnet',
    });

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `withdrawal_requests/${req.id}`);
    }
  }

  async function handleSaveEngineModule(payload: {
    prompt: string;
    result: EngineGeneratedModuleResult;
  }) {
    if (!authUser) return;
    const uid = authUser.uid;
    const moduleId = generateSafeId('mod');
    const lastOutputJson = JSON.stringify(payload.result.executionOutput ?? null).slice(0, 16384);
    try {
      await setDoc(doc(db, 'users', uid, 'engine_modules', moduleId), {
        id: moduleId,
        userId: uid,
        title: payload.result.title.slice(0, 140),
        summary: payload.result.summary.slice(0, 500),
        prompt: payload.prompt.slice(0, 2000),
        entryFunctionName: payload.result.entryFunctionName.slice(0, 80),
        code: payload.result.code.slice(0, 32768),
        testCode: payload.result.testCode.slice(0, 16384),
        sampleInputJson: payload.result.sampleInputJson.slice(0, 8192),
        verified: true,
        totalAttempts: Math.min(3, Math.max(1, payload.result.totalAttempts)),
        lastOutputJson,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `users/${uid}/engine_modules/${moduleId}`);
    }
  }

  async function handleDeleteEngineModule(moduleId: string) {
    if (!authUser) return;
    const uid = authUser.uid;
    try {
      await deleteDoc(doc(db, 'users', uid, 'engine_modules', moduleId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `users/${uid}/engine_modules/${moduleId}`);
    }
  }

  async function handleSaveAdsterraConfig(config: Omit<AdsterraConfig, 'updatedAt'>) {
    if (!authUser || authUser.email !== ADMIN_EMAIL) return;
    try {
      await setDoc(doc(db, 'app_settings', 'adsterra_config'), {
        ...config,
        id: 'adsterra_config',
        updatedBy: authUser.email,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'app_settings/adsterra_config');
    }
  }

  // Loading state
  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#080E1A] flex items-center justify-center p-6">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-2 border-[#00D18C] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-slate-400">جاري تهيئة الجلسة الآمنة...</p>
        </div>
      </div>
    );
  }

  // Unauthenticated Landing & Login Screen
  if (!authUser || !authUser.emailVerified) {
    return (
      <div className="min-h-screen bg-[#080E1A] text-slate-100 flex flex-col">
        <AdsterraAdUnit variant="global_scripts" config={effectiveAdsterraConfig} />
        <header className="border-b border-slate-800/80 px-6 py-4">
          <div className="max-w-7xl mx-auto flex items-center justify-between gap-8">
            <span className="text-lg font-bold text-white whitespace-nowrap shrink-0">
              قطف USDT
            </span>
            <button
              type="button"
              disabled={signingIn}
              onClick={handleGoogleSignIn}
              className="min-h-[42px] px-5 py-2 rounded-xl bg-[#00D18C] hover:bg-[#00b87a] text-[#051812] text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {signingIn ? 'جاري التحقق...' : 'دخول بحساب Google'}
            </button>
          </div>
        </header>

        <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-10 lg:py-16 grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
          <div className="lg:col-span-7 flex flex-col justify-center space-y-6">
            <p className="text-xs font-semibold text-[#00D18C]">
              منصة المكافآت والتحويل المباشر · شبكتا TRC20 و BEP20
            </p>
            <h1 className="text-3xl sm:text-5xl font-extrabold text-white leading-tight">
              اربح عملة USDT الحقيقية وحوّلها مباشرة إلى محفظة Trust Wallet
            </h1>
            <p className="text-base text-slate-300 leading-relaxed max-w-2xl">
              شاهد الإعلانات الموثقة لمدة ثانية واحدة بلا حد يومي (50 نقطة لكل إعلان)، وأكمل المهام التقنية الحقيقية، ثم اسحب أرباحك عبر عقود البلوكشين الذكية مع تغطية كاملة لرسوم الغاز.
            </p>

            {authError && (
              <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 max-w-xl">
                {authError}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-4 pt-2">
              <button
                type="button"
                disabled={signingIn}
                onClick={handleGoogleSignIn}
                className="min-h-[52px] px-7 py-3 rounded-xl bg-[#00D18C] hover:bg-[#00b87a] text-[#051812] font-bold text-sm flex items-center gap-2.5 transition-colors cursor-pointer"
              >
                <Wallet className="w-5 h-5" />
                <span>{signingIn ? 'جاري تسجيل الدخول...' : 'ابدأ الآن عبر حساب Google'}</span>
              </button>
              <span className="text-xs text-slate-400">
                1,000 نقطة = 1.00 USDT · حد أدنى منخفض للسحب
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-6 border-t border-slate-800/80">
              <div>
                <p className="text-sm font-bold text-white">إعلانات بلا حد يومي</p>
                <p className="text-xs text-slate-400 mt-1">50 نقطة مضمونة كل ثانية بتحقق خادمي</p>
              </div>
              <div>
                <p className="text-sm font-bold text-white">دعم TRC20 و BEP20</p>
                <p className="text-xs text-slate-400 mt-1">فحص Checksum فوري لعنوان Trust Wallet</p>
              </div>
              <div>
                <p className="text-sm font-bold text-white">رسوم غاز مغطاة 100%</p>
                <p className="text-xs text-slate-400 mt-1">وصول المبلغ صافياً مع رابط TronScan أو BscScan</p>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 flex">
            <div className="w-full rounded-2xl overflow-hidden border border-slate-800 bg-[#11192C] relative min-h-[300px]">
              <img
                src="/src/assets/images/crypto_vault_hero_1794925352419.jpg"
                alt="خزنة الأصول الرقمية USDT"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#080E1A] via-[#080E1A]/30 to-transparent" />
              <div className="absolute bottom-5 right-5 left-5 p-4 rounded-xl bg-[#0F172A]/90 backdrop-blur-md border border-slate-800 space-y-1">
                <p className="text-xs font-bold text-[#00D18C]">ربط موثق مع Trust Wallet</p>
                <p className="text-xs text-slate-300 leading-relaxed">
                  مصادقة Google آمنة، حماية من السحب المتكرر، وتوقيع معاملات البلوكشين عبر العقد الذكي الرسمي لـ USDT.
                </p>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Loading user profile doc from Firestore
  if (!profile) {
    return (
      <div className="min-h-screen bg-[#080E1A] flex items-center justify-center p-6">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-2 border-[#00D18C] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-slate-400">جاري تحميل محفظتك من قاعدة البيانات...</p>
        </div>
      </div>
    );
  }

  const usdtBalance = pointsToUsdt(profile.points);
  const progressToMinWithdraw = Math.min(
    100,
    Math.round((profile.points / MIN_WITHDRAWAL_POINTS) * 100)
  );
  const featuredCampaign = AD_CAMPAIGNS[profile.adsWatchedCount % AD_CAMPAIGNS.length];

  async function launchAdWithFreshToken(campaign: AdCampaign) {
    await refreshFreshToken();
    setActiveAdCampaign(campaign);
  }

  const navItems: Array<{ id: ActiveTab; label: string; mobileLabel: string }> = [
    { id: 'home', label: 'الرئيسية', mobileLabel: 'الرئيسية' },
    { id: 'earn', label: 'المهام والإعلانات', mobileLabel: 'المهام' },
    { id: 'wallet', label: 'السحب والمحفظة', mobileLabel: 'السحب' },
    { id: 'history', label: 'سجل التحويلات', mobileLabel: 'السجل' },
    { id: 'engine', label: 'الإدارة الذاتية', mobileLabel: 'المحرك' },
  ];

  return (
    <div className="min-h-screen bg-[#080E1A] text-slate-100 pb-20 md:pb-12">
      <AdsterraAdUnit variant="global_scripts" config={effectiveAdsterraConfig} />
      {/* Desktop Top Bar (Strict 3-Zone Contract) */}
      <header className="hidden md:block sticky top-0 z-30 bg-[#080E1A]/90 backdrop-blur-md border-b border-slate-800/80">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <button
            type="button"
            onClick={() => setActiveTab('home')}
            className="text-lg font-extrabold text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            قطف USDT
          </button>

          <nav className="flex items-center gap-6 text-sm font-medium">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === item.id
                    ? 'border-[#00D18C] text-white font-semibold'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <button
            type="button"
            onClick={handleSignOut}
            className="min-h-[40px] px-4 py-2 rounded-xl bg-[#11192C] hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-200 flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5 text-slate-400" />
            <span className="truncate max-w-[140px]">{profile.displayName}</span>
          </button>
        </div>
      </header>

      {/* Mobile Compact Sticky Top Bar (52px) */}
      <header className="md:hidden sticky top-0 z-30 h-[52px] px-4 bg-[#080E1A]/90 backdrop-blur-md border-b border-slate-800/80 flex items-center justify-between">
        <span className="text-base font-extrabold text-white whitespace-nowrap">قطف USDT</span>
        <div className="flex items-center gap-3">
          <span className="font-mono tabular-nums text-xs font-bold text-[#00D18C]">
            {usdtBalance.toFixed(2)} USDT
          </span>
          <button
            type="button"
            onClick={handleSignOut}
            aria-label="تسجيل الخروج"
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-400 hover:text-white cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-8">
        {activeTab === 'home' && (
          <div className="space-y-8">
            {/* Hero Wallet Overview Split (items-stretch) */}
            <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
              <div className="lg:col-span-7 bg-[#11192C] border border-slate-800/90 rounded-2xl p-6 flex flex-col justify-between gap-6">
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                    <span>رصيدك المتاح للتحويل الفوري</span>
                    <span className="font-mono tabular-nums">
                      {formatNumberAr(POINTS_PER_USDT)} نقطة = 1.00 USDT
                    </span>
                  </div>

                  <div className="flex flex-wrap items-baseline gap-4">
                    <div className="font-mono tabular-nums text-4xl sm:text-5xl font-bold text-white">
                      {formatNumberAr(profile.points)}
                      <span className="text-base font-normal text-slate-400 mr-2">نقطة</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-lg sm:text-xl font-mono tabular-nums font-bold text-[#00D18C]">
                      <ArrowLeftRight className="w-4 h-4" />
                      <span>{usdtBalance.toFixed(2)} USDT</span>
                    </div>
                  </div>

                  {/* Progress toward Minimum Withdrawal */}
                  <div className="space-y-2 pt-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">التقدم نحو الحد الأدنى للسحب (1.00 USDT)</span>
                      <span className="font-mono tabular-nums text-slate-200">
                        {progressToMinWithdraw}%
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-[#0B1221] overflow-hidden">
                      <div
                        className="h-full bg-[#00D18C] transition-all duration-300"
                        style={{ width: `${progressToMinWithdraw}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => launchAdWithFreshToken(featuredCampaign)}
                    className="min-h-[48px] flex-1 px-5 py-3 rounded-xl bg-[#00D18C] hover:bg-[#00b87a] text-[#051812] font-bold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    <span>مشاهدة إعلان (+{AD_REWARD_POINTS} نقطة)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('wallet')}
                    className="min-h-[48px] flex-1 px-5 py-3 rounded-xl bg-[#0B1221] hover:bg-slate-800 border border-slate-700 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <Wallet className="w-4 h-4 text-[#00D18C]" />
                    <span>سحب إلى Trust Wallet</span>
                  </button>
                </div>
              </div>

              <div className="lg:col-span-5 bg-[#11192C] border border-slate-800/90 rounded-2xl overflow-hidden relative min-h-[240px]">
                <img
                  src="/src/assets/images/crypto_vault_hero_1794925352419.jpg"
                  alt="محفظة قطف USDT المشفرة"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#080E1A] via-[#080E1A]/40 to-transparent" />
                <div className="absolute bottom-5 right-5 left-5 space-y-1.5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#00D18C]">
                    <ShieldCheck className="w-4 h-4" />
                    <span>حالة ربط Trust Wallet</span>
                  </div>
                  {profile.linkedWalletAddress ? (
                    <p dir="ltr" className="font-mono text-xs text-white truncate">
                      {profile.linkedNetwork} · {profile.linkedWalletAddress}
                    </p>
                  ) : (
                    <p className="text-xs text-slate-300">
                      لم يتم ربط عنوان سحب بعد — انتقل إلى تبويب السحب والمحفظة لإضافة عنوانك.
                    </p>
                  )}
                </div>
              </div>
            </section>

            {/* 4-Column KPI Strip */}
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-[#11192C] border border-slate-800/90 rounded-2xl p-5 space-y-1.5">
                <p className="text-xs text-slate-400">إجمالي النقاط المكتسبة</p>
                <p className="font-mono tabular-nums text-2xl font-bold text-white">
                  {formatNumberAr(profile.totalEarnedPoints)}
                </p>
                <p className="text-[11px] text-slate-500">رصيد تراكمي موثق</p>
              </div>
              <div className="bg-[#11192C] border border-slate-800/90 rounded-2xl p-5 space-y-1.5">
                <p className="text-xs text-slate-400">الإعلانات المكتملة</p>
                <p className="font-mono tabular-nums text-2xl font-bold text-[#F59E0B]">
                  {formatNumberAr(profile.adsWatchedCount)}
                </p>
                <p className="text-[11px] text-slate-500">بدون حد يومي · ثانية واحدة</p>
              </div>
              <div className="bg-[#11192C] border border-slate-800/90 rounded-2xl p-5 space-y-1.5">
                <p className="text-xs text-slate-400">المهام المنجزة</p>
                <p className="font-mono tabular-nums text-2xl font-bold text-white">
                  {formatNumberAr(profile.tasksCompletedCount)}
                </p>
                <p className="text-[11px] text-slate-500">تحقق خادمي فوري</p>
              </div>
              <div className="bg-[#11192C] border border-slate-800/90 rounded-2xl p-5 space-y-1.5">
                <p className="text-xs text-slate-400">إجمالي السحوبات</p>
                <p className="font-mono tabular-nums text-2xl font-bold text-[#00D18C]">
                  {profile.totalWithdrawnUsdt.toFixed(2)} <span className="text-xs">USDT</span>
                </p>
                <p className="text-[11px] text-slate-500">صافي بدون رسوم غاز</p>
              </div>
            </section>

            {/* Live Network RPC Status & Featured Ad Strip */}
            <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-6 bg-[#11192C] border border-slate-800/90 rounded-2xl p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold text-white">حالة شبكات البلوكشين للسحب</h3>
                  <Coins className="w-5 h-5 text-[#00D18C]" />
                </div>
                <div className="divide-y divide-slate-800/80">
                  {(['BEP20', 'TRC20'] as NetworkType[]).map((net) => {
                    const meta = NETWORK_METADATA[net];
                    const quote = quotes.find((q) => q.network === net);
                    return (
                      <div key={net} className="py-3.5 flex items-center justify-between gap-4">
                        <div className="space-y-0.5">
                          <p className="text-sm font-semibold text-white">{meta.label}</p>
                          <p className="text-xs text-slate-400 font-mono tabular-nums">
                            {quote?.blockNumber
                              ? `كتلة #${formatNumberAr(quote.blockNumber)} · متصل`
                              : 'عقد USDT الرسمي جاهز'}
                          </p>
                        </div>
                        <div className="text-left shrink-0">
                          <span className="text-xs font-semibold text-[#00D18C] flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            غاز مغطى من المنصة
                          </span>
                          <p className="font-mono tabular-nums text-[11px] text-slate-400 mt-0.5">
                            {quote ? quote.estimatedGasNative : 'تغطية 100%'}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="lg:col-span-6 bg-[#11192C] border border-slate-800/90 rounded-2xl p-5 sm:p-6 flex flex-col justify-between gap-4">
                <div className="space-y-2">
                  <p className="text-xs text-[#F59E0B] font-semibold">
                    حملة إعلانية مقترحة · +{AD_REWARD_POINTS} نقطة
                  </p>
                  <h3 className="text-lg font-bold text-white leading-snug">
                    {featuredCampaign.title}
                  </h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    {featuredCampaign.summary}
                  </p>
                </div>
                <div className="flex items-center justify-between pt-3 border-t border-slate-800/80">
                  <span className="text-xs text-slate-400">المدة: ثانية واحدة · بلا حد يومي</span>
                  <button
                    type="button"
                    onClick={() => setActiveTab('earn')}
                    className="min-h-[42px] px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold cursor-pointer"
                  >
                    عرض كل المهام والإعلانات
                  </button>
                </div>
              </div>
            </section>

            {/* Live Adsterra Compact Placement (renders when publisher IDs are active) */}
            {effectiveAdsterraConfig.enabled && (
              <section className="space-y-4">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <AdsterraAdUnit variant="banner" config={effectiveAdsterraConfig} compact />
                  <AdsterraAdUnit variant="native" config={effectiveAdsterraConfig} compact />
                </div>
                <AdsterraAdUnit variant="direct_link" config={effectiveAdsterraConfig} compact />
              </section>
            )}
          </div>
        )}

        {activeTab === 'earn' && (
          <TasksAndAdsView
            profile={profile}
            idToken={idToken}
            completions={taskCompletions}
            adsterraConfig={effectiveAdsterraConfig}
            isAdmin={authUser.email === ADMIN_EMAIL}
            onStartAd={launchAdWithFreshToken}
            onAdRewardClaimed={handleAdRewardClaimed}
            onCompleteTask={handleCompleteTask}
            onNavigateToWallet={() => setActiveTab('wallet')}
            onOpenAdsterraSetup={() => setActiveTab('engine')}
            onRefreshToken={refreshFreshToken}
          />
        )}

        {activeTab === 'wallet' && (
          <WalletWithdrawView
            profile={profile}
            idToken={idToken}
            quotes={quotes}
            onSaveLinkedWallet={handleSaveLinkedWallet}
            onRecordWithdrawal={handleRecordWithdrawal}
            onRefreshQuotes={refreshNetworkQuotes}
            onRefreshToken={refreshFreshToken}
          />
        )}

        {activeTab === 'history' && (
          <HistoryView
            withdrawals={withdrawals}
            adLogs={adLogs}
            taskCompletions={taskCompletions}
            isAdmin={authUser.email === ADMIN_EMAIL}
            adminRequests={adminRequests}
            onAdminConfirmRequest={handleAdminConfirmRequest}
          />
        )}

        {activeTab === 'engine' && (
          <SelfEngineView
            idToken={idToken}
            isAdmin={authUser.email === ADMIN_EMAIL}
            userEmail={authUser.email || ''}
            savedModules={engineModules}
            adsterraConfig={effectiveAdsterraConfig}
            onSaveEngineModule={handleSaveEngineModule}
            onDeleteEngineModule={handleDeleteEngineModule}
            onSaveAdsterraConfig={handleSaveAdsterraConfig}
          />
        )}
      </main>

      {/* Mobile Bottom Thumb-Zone Navigation (5 Tabs, h-16) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0F172A]/95 backdrop-blur-md border-t border-slate-800 pb-safe">
        <div className="grid grid-cols-5 h-16 items-center">
          {[
            { id: 'home', label: 'الرئيسية', Icon: LayoutDashboard },
            { id: 'earn', label: 'المهام', Icon: ListChecks },
            { id: 'wallet', label: 'السحب', Icon: Wallet },
            { id: 'history', label: 'السجل', Icon: History },
            { id: 'engine', label: 'المحرك', Icon: Cpu },
          ].map(({ id, label, Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id as ActiveTab)}
                className={`min-h-[44px] flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors cursor-pointer ${
                  active ? 'text-[#00D18C] font-bold' : 'text-slate-400'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Ad Player Modal */}
      {activeAdCampaign && (
        <AdPlayerModal
          campaign={activeAdCampaign}
          adsterraConfig={effectiveAdsterraConfig}
          idToken={idToken}
          onClose={() => setActiveAdCampaign(null)}
          onRewardClaimed={handleAdRewardClaimed}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <QatfApp />
    </ErrorBoundary>
  );
}
