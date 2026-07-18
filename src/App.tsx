import React, { useState, useEffect, useMemo, useRef, Component } from 'react';
import Papa from 'papaparse';
import { CheckCircle, AlertCircle, Users, Wallet, Plus, Search, Upload, Loader2, Calendar, LogIn, Key, LogOut, Trash2, Filter, Clock, X, Download, RefreshCw, TrendingDown, TrendingUp, DollarSign } from 'lucide-react';
import * as XLSX from 'xlsx';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db, googleProvider } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, getDoc, writeBatch, serverTimestamp, getDocFromServer, getDocs } from 'firebase/firestore';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  return errInfo;
}

type Month = 'JAN' | 'FEV' | 'MARS' | 'AVRIL' | 'MAI' | 'JUIN' | 'JUILL' | 'AOUT' | 'SEP' | 'OCT' | 'NOV' | 'DEC';

const MONTHS: Month[] = ['JAN', 'FEV', 'MARS', 'AVRIL', 'MAI', 'JUIN', 'JUILL', 'AOUT', 'SEP', 'OCT', 'NOV', 'DEC'];
const YEARS = [2025, 2026, 2027, 2028, 2029, 2030];

type MemberCategory = 'Adhérent' | 'Cadre';

const CATEGORY_ANNUAL_TARGET: Record<MemberCategory, number> = {
  'Adhérent': 6000,
  'Cadre': 12000
};

const CATEGORY_MONTHLY_DUE: Record<MemberCategory, number> = {
  'Adhérent': 500,
  'Cadre': 1000
};

const createEmptyYear = () => MONTHS.reduce((acc, month) => ({ ...acc, [month]: '' }), {} as Record<Month, number | ''>);

const redistributePayments = (allPayments: Record<number, Record<Month, number | ''>>, category: MemberCategory = 'Adhérent') => {
  const monthlyDue = CATEGORY_MONTHLY_DUE[category];
  
  // 1. Calculate total sum of all payments across all years
  let totalSum = 0;
  Object.values(allPayments).forEach(yearData => {
    Object.values(yearData).forEach(val => {
      if (typeof val === 'number') totalSum += val;
    });
  });

  // 2. Create new empty structure for all years
  const newPayments: Record<number, Record<Month, number | ''>> = {};
  YEARS.forEach(y => {
    newPayments[y] = createEmptyYear();
  });

  // 3. Distribute totalSum starting from the earliest year and month
  let remaining = totalSum;
  for (const year of YEARS) {
    for (const month of MONTHS) {
      if (remaining <= 0) break;
      const amountToFill = Math.min(remaining, monthlyDue);
      newPayments[year][month] = amountToFill;
      remaining -= amountToFill;
    }
    if (remaining <= 0) break;
  }
  
  return newPayments;
};

interface Transaction {
  id: string;
  date: string;
  year: number;
  month: Month;
  amount: number | '';
  previousAmount: number | '';
}

interface Member {
  id: string; // This is the personal code
  name: string;
  category?: MemberCategory;
  payments: Record<number, Record<Month, number | ''>>;
  createdAt?: any;
  history?: Transaction[];
}

interface Expense {
  id: string;
  description: string;
  amount: number;
  month: Month;
  year: number;
  createdAt: any;
}

interface Revenue {
  id: string;
  description: string;
  amount: number;
  month: Month;
  year: number;
  createdAt: any;
}

const generateCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

const speakName = (name: string) => {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    // Prononcer le nom en entier
    const utterance = new SpeechSynthesisUtterance(name);
    utterance.lang = 'fr-FR';
    utterance.rate = 1.0; // Vitesse normale
    window.speechSynthesis.speak(utterance);
  }
};

const stopSpeaking = () => {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
};

const getPaymentBreakdown = (member: Member, year: number, month: Month) => {
  const amount = member.payments[year]?.[month];
  if (typeof amount !== 'number' || amount <= 0) return null;

  const category = member.category || 'Adhérent';
  const annualTarget = CATEGORY_ANNUAL_TARGET[category];
  const monthlyDue = CATEGORY_MONTHLY_DUE[category];

  const currentMonthIndex = MONTHS.indexOf(month);

  // 1. Calculate cumulative expected up to the START of the current month
  let cumulativeOwedAtStart = 0;
  for (const y of YEARS) {
    if (y < year) {
      cumulativeOwedAtStart += annualTarget;
    } else if (y === year) {
      cumulativeOwedAtStart += currentMonthIndex * monthlyDue;
      break;
    }
  }

  // 2. Calculate cumulative paid up to the START of the current month
  let cumulativePaidAtStart = 0;
  for (const y of YEARS) {
    if (y > year) break;
    for (const m of MONTHS) {
      const idx = MONTHS.indexOf(m);
      if (y < year || (y === year && idx < currentMonthIndex)) {
        const p = member.payments[y]?.[m];
        if (typeof p === 'number') cumulativePaidAtStart += p;
      } else {
        break;
      }
    }
  }

  // 3. Current debt at start of this month
  const totalDebtAtStart = Math.max(0, cumulativeOwedAtStart - cumulativePaidAtStart);
  if (totalDebtAtStart <= 0) return null;

  const recoveryAmount = Math.min(amount, totalDebtAtStart);
  
  // 4. Identify which year is being recovered
  let recoveredYear = 2025;
  let runningTotal = 0;
  for (const y of YEARS) {
    runningTotal += annualTarget;
    if (runningTotal > cumulativePaidAtStart) {
      recoveredYear = y;
      break;
    }
  }

  return { recoveryAmount, recoveredYear };
};

const PaymentCell = ({ 
  initialValue, 
  onSave 
}: { 
  initialValue: number | '', 
  onSave: (val: string) => void 
}) => {
  const [localValue, setLocalValue] = useState<string>(initialValue.toString());

  useEffect(() => {
    setLocalValue(initialValue.toString());
  }, [initialValue]);

  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={localValue === '' ? '' : localValue}
      onChange={(e) => {
        const val = e.target.value.replace(/[^0-9]/g, '');
        setLocalValue(val);
      }}
      onBlur={() => {
        if (localValue !== initialValue.toString()) {
          onSave(localValue);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="w-16 p-1.5 text-sm border border-slate-200 rounded-md focus:ring-2 focus:ring-degha-green focus:border-degha-green text-center text-slate-700 bg-white shadow-inner transition-all duration-300"
      placeholder="0"
    />
  );
};

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: any;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState;
  public props: ErrorBoundaryProps;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center space-y-4 border border-rose-100">
            <div className="w-16 h-16 bg-rose-100 text-rose-600 rounded-full flex items-center justify-center mx-auto">
              <AlertCircle className="w-10 h-10" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Oups ! Quelque chose s'est mal passé.</h1>
            <p className="text-slate-600">
              Une erreur inattendue est survenue. Veuillez rafraîchir la page ou contacter l'administrateur.
            </p>
            <div className="bg-slate-50 p-4 rounded-xl text-left overflow-auto max-h-40">
              <code className="text-xs text-rose-500">
                {this.state.error?.message || String(this.state.error)}
              </code>
            </div>
            <button 
              onClick={() => window.location.reload()}
              className="w-full bg-slate-900 text-white py-3 rounded-xl font-bold hover:bg-slate-800 transition-colors"
            >
              Rafraîchir la page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

function AppContent() {
  const [members, setMembers] = useState<Member[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'UP_TO_DATE' | 'LATE'>('ALL');
  const [memberMonthFilter, setMemberMonthFilter] = useState<'ALL' | Month>('ALL');
  const [memberMonthStatus, setMemberMonthStatus] = useState<'ALL' | 'PAID' | 'UNPAID'>('ALL');
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberCategory, setNewMemberCategory] = useState<MemberCategory>('Adhérent');
  const [isImporting, setIsImporting] = useState(false);
  const [currentYear, setCurrentYear] = useState<number>(new Date().getFullYear() >= 2025 && new Date().getFullYear() <= 2030 ? new Date().getFullYear() : 2025);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [historyModalMember, setHistoryModalMember] = useState<Member | null>(null);

  // Expenses State
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expenseDesc, setExpenseDesc] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseMonth, setExpenseMonth] = useState<Month>('JAN');
  const [expenseYear, setExpenseYear] = useState<number>(new Date().getFullYear() >= 2025 && new Date().getFullYear() <= 2030 ? new Date().getFullYear() : 2025);
  const [expenseFilterMonth, setExpenseFilterMonth] = useState<'ALL' | Month>('ALL');

  // Revenues State (Entrées Exceptionnelles)
  const [revenues, setRevenues] = useState<Revenue[]>([]);
  const [revenueDesc, setRevenueDesc] = useState('');
  const [revenueAmount, setRevenueAmount] = useState('');
  const [revenueMonth, setRevenueMonth] = useState<Month>('JAN');
  const [revenueYear, setRevenueYear] = useState<number>(new Date().getFullYear() >= 2025 && new Date().getFullYear() <= 2030 ? new Date().getFullYear() : 2025);
  const [revenueFilterMonth, setRevenueFilterMonth] = useState<'ALL' | Month>('ALL');

  const [confirmDialog, setConfirmDialog] = useState<{ isOpen: boolean; message: string; title: string; isDanger: boolean; onConfirm: () => void } | null>(null);

  const [activeAdminTab, setActiveAdminTab] = useState<'members' | 'expenses' | 'revenues'>('members');

  // Auth State
  const [userRole, setUserRole] = useState<'admin' | 'member' | null>(null);
  const [adminUser, setAdminUser] = useState<User | null>(null);
  const [memberData, setMemberData] = useState<Member | null>(null);
  const [memberCodeInput, setMemberCodeInput] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // PWA Install State
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showInstallBtn, setShowInstallBtn] = useState(false);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallBtn(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      console.log('User accepted the install prompt');
    }
    setDeferredPrompt(null);
    setShowInstallBtn(false);
  };

  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. ");
          setLoginError("Erreur de connexion : le client est hors ligne. Vérifiez votre configuration Firebase.");
        }
      }
    }
    testConnection();

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setAdminUser(user);
        setUserRole('admin');
      } else {
        setAdminUser(null);
        if (userRole === 'admin') setUserRole(null);
      }
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, [userRole]);

  useEffect(() => {
    if (userRole === 'admin' && isAuthReady) {
      const unsubscribe = onSnapshot(collection(db, 'members'), (snapshot) => {
        const membersData: Member[] = [];
        snapshot.forEach((doc) => {
          membersData.push({ id: doc.id, ...doc.data() } as Member);
        });
        setMembers(membersData);
      }, (error) => {
        console.error("Erreur Firestore:", error);
      });
      return () => unsubscribe();
    }
  }, [userRole, isAuthReady]);

  useEffect(() => {
    if (userRole && isAuthReady) {
      const unsubscribe = onSnapshot(collection(db, 'expenses'), (snapshot) => {
        const expensesData: Expense[] = [];
        snapshot.forEach((doc) => {
          expensesData.push({ id: doc.id, ...doc.data() } as Expense);
        });
        setExpenses(expensesData);
      }, (error) => {
        console.error("Erreur Firestore (expenses):", error);
      });
      return () => unsubscribe();
    }
  }, [userRole, isAuthReady]);

  useEffect(() => {
    if (userRole && isAuthReady) {
      const unsubscribe = onSnapshot(collection(db, 'revenues'), (snapshot) => {
        const revenuesData: Revenue[] = [];
        snapshot.forEach((doc) => {
          revenuesData.push({ id: doc.id, ...doc.data() } as Revenue);
        });
        setRevenues(revenuesData);
      }, (error) => {
        console.error("Erreur Firestore (revenues):", error);
      });
      return () => unsubscribe();
    }
  }, [userRole, isAuthReady]);

  const handleAdminLogin = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    try {
      setLoginError('');
      await signInWithPopup(auth, googleProvider);
    } catch (error: any) {
      console.error("Erreur de connexion:", error);
      if (error.code === 'auth/popup-blocked') {
        setLoginError("Pop-up bloqué par le navigateur. Veuillez autoriser les pop-ups ou ouvrir l'application dans un nouvel onglet.");
      } else if (error.code === 'auth/network-request-failed') {
        setLoginError("Erreur réseau. Le navigateur bloque peut-être la connexion (cookies tiers, AdBlock, etc.). Veuillez ouvrir l'application dans un nouvel onglet.");
      } else if (error.message?.includes('INTERNAL ASSERTION FAILED')) {
        setLoginError("Une erreur interne Firebase est survenue. Veuillez rafraîchir la page et réessayer, ou ouvrir l'application dans un nouvel onglet.");
      } else {
        setLoginError(`Erreur de connexion administrateur: ${error.message || error.code}`);
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleMemberLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    const code = memberCodeInput.trim().toUpperCase();
    if (!code) return;

    try {
      const docRef = doc(db, 'members', code);
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        setMemberData({ id: docSnap.id, ...docSnap.data() } as Member);
        setUserRole('member');
      } else {
        setLoginError("Code personnel invalide.");
      }
    } catch (error: any) {
      const errInfo = handleFirestoreError(error, OperationType.GET, `members/${code}`);
      setLoginError(`Erreur lors de la vérification du code: ${errInfo.error}`);
    }
  };

  const handleLogout = async () => {
    setIsLoggingIn(false);
    if (userRole === 'admin') {
      await signOut(auth);
    }
    setUserRole(null);
    setMemberData(null);
    setMemberCodeInput('');
  };

  const exportToExcel = () => {
    const data = members.map((member, index) => {
      const yearPayments = member.payments[currentYear] || createEmptyYear();
      const total = Object.values(yearPayments).reduce<number>((sum, val) => sum + (typeof val === 'number' ? val : 0), 0);
      
      const row: any = {
        'Ordre': index + 1,
        'Nom & Prenoms': member.name
      };
      
      MONTHS.forEach(m => {
        row[m] = yearPayments[m] === '' ? 0 : yearPayments[m];
      });
      
      row['TOTAL'] = total;
      return row;
    });

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, `Cotisations ${currentYear}`);
    XLSX.writeFile(workbook, `Degha_Cotisations_${currentYear}.xlsx`);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    try {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        await importFromPDF(file);
      } else {
        await importFromExcel(file);
      }
    } catch (error) {
      console.error("Erreur lors de l'importation:", error);
      alert("Erreur lors de l'importation. Vérifiez le format du fichier.");
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const importFromExcel = async (file: File) => {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet);
    
    const batch = writeBatch(db);
    const existingNames = new Map<string, Member>(members.map(m => [m.name.toLowerCase(), m]));
    const processedNames = new Set<string>();

    rows.forEach((row: any, index) => {
      const yearPayments: Record<Month, number | ''> = createEmptyYear();
      
      MONTHS.forEach(m => {
        const key = Object.keys(row).find(k => k.toUpperCase().includes(m) || m.includes(k.toUpperCase()));
        if (key && row[key] !== undefined && row[key] !== null && row[key] !== '') {
          const val = parseInt(row[key], 10);
          if (!isNaN(val)) yearPayments[m] = val;
        }
      });

      const nameKey = Object.keys(row).find(k => k.toLowerCase().includes('nom') || k.toLowerCase().includes('name') || k.toLowerCase().includes('membre'));
      const cleanName = String(nameKey ? row[nameKey] : `Membre Inconnu ${index + 1}`).trim();
      const lowerName = cleanName.toLowerCase();

      if (processedNames.has(lowerName)) return; // Skip duplicates within the file
      processedNames.add(lowerName);

      if (existingNames.has(lowerName)) {
        const existingMember = existingNames.get(lowerName)!;
        const docRef = doc(db, 'members', existingMember.id);
        
        const allPayments = { ...existingMember.payments, [currentYear]: yearPayments };
        // Removed redistribution to maintain fidelity to the source file
        batch.update(docRef, {
          payments: allPayments
        });
      } else {
        const code = generateCode();
        const docRef = doc(db, 'members', code);
        // Removed redistribution to maintain fidelity to the source file
        batch.set(docRef, {
          name: cleanName,
          payments: { [currentYear]: yearPayments },
          createdAt: serverTimestamp()
        });
      }
    });

    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'members (batch)');
      throw error;
    }
  };

  const importFromPDF = async (file: File) => {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const serverRes = await fetch('/api/extract-pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ base64 }),
    });

    if (!serverRes.ok) {
      const errorData = await serverRes.json();
      throw new Error(errorData.error || "Erreur lors de l'extraction par Gemini.");
    }

    const { text: jsonStr } = await serverRes.json();
    if (jsonStr) {
      const parsed = JSON.parse(jsonStr);
      const batch = writeBatch(db);
      const existingNames = new Map<string, Member>(members.map(m => [m.name.toLowerCase(), m]));
      const processedNames = new Set<string>();

      parsed.forEach((item: any, index: number) => {
        const yearPayments: Record<Month, number | ''> = createEmptyYear();
        MONTHS.forEach(m => {
          if (item.payments && typeof item.payments[m] === 'number' && item.payments[m] > 0) {
            yearPayments[m] = item.payments[m];
          }
        });
        
        const cleanName = (item.name || `Membre Inconnu ${index + 1}`).trim();
        const lowerName = cleanName.toLowerCase();

        if (processedNames.has(lowerName)) return; // Skip duplicates within the file
        processedNames.add(lowerName);

        if (existingNames.has(lowerName)) {
          const existingMember = existingNames.get(lowerName)!;
          const docRef = doc(db, 'members', existingMember.id);
          
          const allPayments = { ...existingMember.payments, [currentYear]: yearPayments };
          // Removed redistribution to maintain fidelity to the source file
          batch.update(docRef, {
            payments: allPayments
          });
        } else {
          const code = generateCode();
          const docRef = doc(db, 'members', code);
          // Removed redistribution (keeps exact amounts in exact months)
          batch.set(docRef, {
            name: cleanName,
            payments: { [currentYear]: yearPayments },
            createdAt: serverTimestamp()
          });
        }
      });

      try {
        await batch.commit();
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, 'members (batch)');
        throw error;
      }
    }
  };

  const calculateTotal = (payments: Record<number, Record<Month, number | ''>>, year: number): number => {
    // For "debt-first" logic, the total for a year is only what's allocated to that year
    const yearPayments = payments[year] || createEmptyYear();
    return Object.values(yearPayments).reduce<number>((sum, val) => sum + (typeof val === 'number' ? val : 0), 0);
  };

  const calculateGlobalDebt = (payments: Record<number, Record<Month, number | ''>>, targetYear: number, category: MemberCategory = 'Adhérent') => {
    let totalPaid = 0;
    Object.values(payments).forEach(yearData => {
      Object.values(yearData).forEach(val => {
        if (typeof val === 'number') totalPaid += val;
      });
    });

    const annualTarget = CATEGORY_ANNUAL_TARGET[category];
    const yearsCount = targetYear - 2025 + 1;
    const totalOwed = yearsCount * annualTarget;
    const globalReste = Math.max(0, totalOwed - totalPaid);
    const isUpToDate = totalPaid >= totalOwed;

    return { totalPaid, totalOwed, globalReste, isUpToDate };
  };

  const stats = useMemo(() => {
    let totalCollected = 0;
    let upToDateCount = 0;

    members.forEach(member => {
      const yearTotal = calculateTotal(member.payments, currentYear);
      totalCollected += yearTotal;
      const annualTarget = CATEGORY_ANNUAL_TARGET[member.category || 'Adhérent'];
      if (yearTotal >= annualTarget) {
        upToDateCount++;
      }
    });

    const totalExpenses = expenses
      .filter(exp => exp.year === currentYear)
      .reduce((sum, exp) => sum + exp.amount, 0);

    const totalRevenues = revenues
      .filter(rev => rev.year === currentYear)
      .reduce((sum, rev) => sum + rev.amount, 0);

    const netSolde = totalCollected + totalRevenues - totalExpenses;

    return { totalCollected, upToDateCount, totalExpenses, totalRevenues, netSolde };
  }, [members, expenses, revenues, currentYear]);

  const handlePaymentChange = async (memberId: string, year: number, month: Month, value: string) => {
    const numValue = value === '' ? '' : parseInt(value, 10);
    if (value !== '' && isNaN(numValue as number)) return;

    const member = members.find(m => m.id === memberId);
    if (!member) return;

    const yearData = member.payments[year] || createEmptyYear();
    const previousAmount = yearData[month];
    
    if (previousAmount === numValue) return;

    const newPayments = {
      ...member.payments,
      [year]: { ...yearData, [month]: numValue }
    };

    const newTransaction: Transaction = {
      id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
      date: new Date().toISOString(),
      year,
      month,
      amount: numValue,
      previousAmount
    };

    const newHistory = [...(member.history || []), newTransaction];

    try {
      await updateDoc(doc(db, 'members', memberId), {
        payments: newPayments,
        history: newHistory
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `members/${memberId}`);
    }
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = newMemberName.trim();
    if (!cleanName) return;

    const isDuplicate = members.some(m => m.name.toLowerCase() === cleanName.toLowerCase());
    if (isDuplicate) {
      alert("Un membre avec ce nom existe déjà.");
      return;
    }

    const code = generateCode();
    try {
      await setDoc(doc(db, 'members', code), {
        name: cleanName,
        category: newMemberCategory,
        payments: {},
        createdAt: serverTimestamp()
      });
      setNewMemberName('');
      setNewMemberCategory('Adhérent');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `members/${code}`);
    }
  };

  const handleDeleteMember = (memberId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: "Supprimer le membre",
      message: "Voulez-vous vraiment supprimer ce membre et tout son historique de paiement ?",
      isDanger: true,
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, 'members', memberId));
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `members/${memberId}`);
        }
      }
    });
  };

  const handleCategoryChange = async (memberId: string, category: MemberCategory) => {
    try {
      await updateDoc(doc(db, 'members', memberId), { category });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `members/${memberId}`);
    }
  };

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    const desc = expenseDesc.trim();
    if (!desc) return;
    const amountNum = parseFloat(expenseAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      alert("Veuillez saisir un montant valide supérieur à 0.");
      return;
    }

    try {
      const expenseId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
      await setDoc(doc(db, 'expenses', expenseId), {
        description: desc,
        amount: amountNum,
        month: expenseMonth,
        year: expenseYear,
        createdAt: new Date().toISOString()
      });
      setExpenseDesc('');
      setExpenseAmount('');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `expenses`);
      alert("Erreur lors de l'enregistrement de la dépense.");
    }
  };

  const handleDeleteExpense = (expenseId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: "Supprimer la dépense",
      message: "Voulez-vous vraiment supprimer cette dépense ?",
      isDanger: true,
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, 'expenses', expenseId));
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `expenses/${expenseId}`);
          alert("Erreur lors de la suppression.");
        }
      }
    });
  };

  const handleAddRevenue = async (e: React.FormEvent) => {
    e.preventDefault();
    const desc = revenueDesc.trim();
    if (!desc) return;
    const amountNum = parseFloat(revenueAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      alert("Veuillez saisir un montant valide supérieur à 0.");
      return;
    }

    try {
      const revenueId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
      await setDoc(doc(db, 'revenues', revenueId), {
        description: desc,
        amount: amountNum,
        month: revenueMonth,
        year: revenueYear,
        createdAt: new Date().toISOString()
      });
      setRevenueDesc('');
      setRevenueAmount('');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `revenues`);
      alert("Erreur lors de l'enregistrement de l'entrée.");
    }
  };

  const handleDeleteRevenue = (revenueId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: "Supprimer l'entrée",
      message: "Voulez-vous vraiment supprimer cette entrée ?",
      isDanger: true,
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, 'revenues', revenueId));
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `revenues/${revenueId}`);
          alert("Erreur lors de la suppression.");
        }
      }
    });
  };

  const filteredMembers = members.filter(m => {
    const matchesSearch = m.name.toLowerCase().includes(searchTerm.toLowerCase());
    if (!matchesSearch) return false;
    
    if (statusFilter !== 'ALL') {
      const annualTarget = CATEGORY_ANNUAL_TARGET[m.category || 'Adhérent'];
      const total = calculateTotal(m.payments, currentYear);
      const isUpToDate = total >= annualTarget;
      
      if (statusFilter === 'UP_TO_DATE' && !isUpToDate) return false;
      if (statusFilter === 'LATE' && isUpToDate) return false;
    }
    
    if (memberMonthFilter !== 'ALL' && memberMonthStatus !== 'ALL') {
      const yearPayments = m.payments[currentYear] || {};
      const paidValue = yearPayments[memberMonthFilter];
      const hasPaid = typeof paidValue === 'number' && paidValue > 0;
      
      if (memberMonthStatus === 'PAID' && !hasPaid) return false;
      if (memberMonthStatus === 'UNPAID' && hasPaid) return false;
    }
    
    return true;
  });

  const monthlyTotals = useMemo(() => {
    const totals = {} as Record<Month, number>;
    MONTHS.forEach(m => {
      totals[m] = 0;
    });
    filteredMembers.forEach(member => {
      const yearPayments = member.payments[currentYear] || createEmptyYear();
      MONTHS.forEach(m => {
        const val = yearPayments[m];
        if (typeof val === 'number') {
          totals[m] += val;
        }
      });
    });
    return totals;
  }, [filteredMembers, currentYear]);

  const grandTotal = useMemo(() => {
    return MONTHS.reduce((sum, m) => sum + (monthlyTotals[m] || 0), 0);
  }, [monthlyTotals]);

  const monthlyExpenses = useMemo(() => {
    const totals = {} as Record<Month, number>;
    MONTHS.forEach(m => {
      totals[m] = 0;
    });
    expenses.forEach(exp => {
      if (exp.year === currentYear) {
        totals[exp.month] += exp.amount;
      }
    });
    return totals;
  }, [expenses, currentYear]);

  const grandTotalExpenses = useMemo(() => {
    return MONTHS.reduce((sum, m) => sum + (monthlyExpenses[m] || 0), 0);
  }, [monthlyExpenses]);

  const monthlyRevenues = useMemo(() => {
    const totals = {} as Record<Month, number>;
    MONTHS.forEach(m => {
      totals[m] = 0;
    });
    revenues.forEach(rev => {
      if (rev.year === currentYear) {
        totals[rev.month] += rev.amount;
      }
    });
    return totals;
  }, [revenues, currentYear]);

  const grandTotalRevenues = useMemo(() => {
    return MONTHS.reduce((sum, m) => sum + (monthlyRevenues[m] || 0), 0);
  }, [monthlyRevenues]);

  const netBalance = useMemo(() => {
    return grandTotal + grandTotalRevenues - grandTotalExpenses;
  }, [grandTotal, grandTotalRevenues, grandTotalExpenses]);

  const totalReste = useMemo(() => {
    return filteredMembers.reduce((sum, member) => {
      const annualTarget = CATEGORY_ANNUAL_TARGET[member.category || 'Adhérent'];
      const total = calculateTotal(member.payments, currentYear);
      return sum + Math.max(0, annualTarget - total);
    }, 0);
  }, [filteredMembers, currentYear]);

  if (!isAuthReady) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white space-y-6">
        <div className="relative">
          <div className="w-16 h-16 border-4 border-slate-100 border-t-degha-green rounded-full animate-spin"></div>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 bg-degha-orange rounded-full animate-pulse"></div>
          </div>
        </div>
        <div className="text-center space-y-2">
          <h2 className="text-xl font-black text-slate-900 tracking-tighter uppercase">Degha</h2>
          <p className="text-xs text-slate-400 font-bold tracking-[0.3em] uppercase">Chargement...</p>
        </div>
      </div>
    );
  }

  // Login Screen
  if (!userRole) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4 relative overflow-hidden">
        {/* Vertical Stripes Motif */}
        <div className="absolute left-0 top-0 bottom-0 w-3 bg-degha-orange"></div>
        <div className="absolute left-3 top-0 bottom-0 w-3 bg-white"></div>
        <div className="absolute left-6 top-0 bottom-0 w-3 bg-degha-green"></div>

        <div className="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-md w-full overflow-hidden curled-corner">
          <div className="curled-corner-flag"></div>
          <div className="p-8 space-y-8 relative z-10">
            <div className="text-center space-y-4">
              <div className="flex flex-wrap items-center justify-center gap-2 text-xl font-medium text-slate-800">
                <span>JE SUIS</span>
                <span className="bg-degha-green text-white px-4 py-1 rounded-full font-bold">FIER</span>
                <span>D'ÊTRE</span>
              </div>
              <h1 className="text-5xl font-black text-slate-900 tracking-tighter">DEGHA</h1>
              <p className="text-[10px] uppercase tracking-[0.3em] text-slate-400 font-bold">WELARAFOGO</p>
            </div>

          {loginError && (
            <div className="bg-rose-50 text-rose-600 p-3 rounded-lg text-sm flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{loginError}</span>
            </div>
          )}

          {loginError.includes('nouvel onglet') && (
            <button 
              onClick={() => window.open(window.location.href, '_blank')}
              className="w-full bg-orange-50 hover:bg-white text-degha-orange font-bold py-2 rounded-xl transition-all text-sm border border-orange-200 hover:border-degha-orange shadow-sm"
            >
              Ouvrir dans un nouvel onglet
            </button>
          )}

          <form onSubmit={handleMemberLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Code Personnel (Membre)</label>
              <div className="relative">
                <Key className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={memberCodeInput}
                  onChange={(e) => setMemberCodeInput(e.target.value.toUpperCase())}
                  placeholder="Ex: A7B29F"
                  className="pl-10 pr-4 py-3 w-full border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none uppercase font-mono tracking-widest"
                />
              </div>
            </div>
            <button type="submit" className="w-full bg-degha-green hover:bg-white text-white hover:text-degha-green font-bold py-3 rounded-xl transition-all border border-transparent hover:border-degha-green shadow-lg">
              Accéder à mes cotisations
            </button>
          </form>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-200"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-white text-slate-500">Ou</span>
            </div>
          </div>

          <button 
            onClick={handleAdminLogin}
            disabled={isLoggingIn}
            className="w-full flex items-center justify-center gap-3 bg-slate-900 hover:bg-slate-800 text-white font-bold py-3 rounded-xl transition-all shadow-lg disabled:opacity-50"
          >
            {isLoggingIn ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogIn className="w-5 h-5" />}
            {isLoggingIn ? 'Connexion en cours...' : 'Connexion Administrateur'}
          </button>

          {showInstallBtn && (
            <motion.button
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={handleInstallClick}
              className="w-full flex items-center justify-center gap-3 bg-degha-orange hover:bg-white text-white hover:text-degha-orange font-bold py-3 rounded-xl transition-all border border-transparent hover:border-degha-orange shadow-lg mt-4"
            >
              <Download className="w-5 h-5" />
              Installer l'application
            </motion.button>
          )}
        </div>
      </div>
    </div>
    );
  }

  // Member View
  if (userRole === 'member' && memberData) {
    const { totalPaid, globalReste, isUpToDate } = calculateGlobalDebt(memberData.payments, currentYear, memberData.category);
    const yearPayments = memberData.payments[currentYear] || createEmptyYear();
    const annualTarget = CATEGORY_ANNUAL_TARGET[memberData.category || 'Adhérent'];

    return (
      <div className="min-h-screen bg-white p-4 md:p-8 relative">
        {/* Vertical Stripes Motif */}
        <div className="fixed left-0 top-0 bottom-0 w-2 bg-degha-orange"></div>
        <div className="fixed left-2 top-0 bottom-0 w-2 bg-white"></div>
        <div className="fixed left-4 top-0 bottom-0 w-2 bg-degha-green"></div>

        <div className="max-w-4xl mx-auto space-y-6">
          <header className="flex items-center justify-between bg-white p-8 rounded-2xl shadow-lg border-l-8 border-degha-green relative overflow-hidden">
            <div className="relative z-10">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-bold text-degha-green uppercase tracking-widest">Espace Degha</span>
                <div className="h-px w-8 bg-degha-orange"></div>
              </div>
              <h1 className="text-3xl font-black text-slate-900">Bonjour, {memberData.name}</h1>
              <p className="text-slate-500 font-medium mt-1">WELARA • Votre situation ({memberData.category || 'Adhérent'})</p>
            </div>
            <button onClick={handleLogout} className="relative z-10 text-slate-600 hover:text-degha-green flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-100 hover:bg-white transition-all border border-slate-200 hover:border-degha-green shadow-sm">
              <LogOut className="w-4 h-4" />
              Déconnexion
            </button>
          </header>

          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
             <div className="flex items-center gap-2 bg-slate-50 px-4 py-2 rounded-xl border border-slate-200">
                <Calendar className="w-5 h-5 text-slate-500" />
                <select 
                  value={currentYear} 
                  onChange={(e) => setCurrentYear(Number(e.target.value))}
                  className="bg-transparent outline-none text-lg font-bold text-blue-600 cursor-pointer"
                >
                  {YEARS.map(y => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>

              <div className="flex gap-4">
                <div className="text-center px-6 py-3 bg-orange-50 rounded-xl border border-orange-200">
                  <p className="text-sm text-degha-orange font-bold">Total Payé (Global)</p>
                  <p className="text-xl font-black text-slate-900">{totalPaid.toLocaleString()} FCFA</p>
                </div>
                <div className="text-center px-6 py-3 bg-green-50 rounded-xl border border-green-200">
                  <p className="text-sm text-degha-green font-bold">Reste à payer (Dette)</p>
                  <p className={`text-xl font-black ${globalReste > 0 ? 'text-rose-600' : 'text-degha-green'}`}>
                    {globalReste > 0 ? globalReste.toLocaleString() : '0'} FCFA
                  </p>
                </div>
              </div>
          </div>

          {/* Message d'explication sur la dette */}
          {currentYear > 2025 && (() => {
            const memberCategory = memberData.category || 'Adhérent';
            const annualTarget = CATEGORY_ANNUAL_TARGET[memberCategory];

            const paidBeforeCurrent = Object.keys(memberData.payments)
              .filter(y => Number(y) < currentYear)
              .reduce((sum, y) => sum + calculateTotal(memberData.payments, Number(y)), 0);
            const owedBeforeCurrent = (currentYear - 2025) * annualTarget;
            const debtFromPast = Math.max(0, owedBeforeCurrent - paidBeforeCurrent);
            
            if (debtFromPast > 0) {
              return (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-r-xl"
                >
                  <div className="flex gap-3">
                    <AlertCircle className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-bold text-blue-900">Note sur vos cotisations</p>
                      <p className="text-sm text-blue-800 mt-1">
                        Vous aviez un retard de <span className="font-bold">{debtFromPast.toLocaleString()} FCFA</span> sur les années précédentes. 
                        Vos derniers versements ont été prioritairement utilisés pour solder cette dette avant de compter pour l'année {currentYear}.
                      </p>
                    </div>
                  </div>
                </motion.div>
              );
            }
            return null;
          })()}

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-200 bg-slate-50/50 flex justify-between items-center">
              <h2 className="font-semibold text-slate-800">Détails de l'année {currentYear}</h2>
              <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-bold border ${
                isUpToDate ? 'bg-green-50 text-degha-green border-green-200' : 'bg-orange-50 text-degha-orange border-orange-200'
              }`}>
                {isUpToDate ? <CheckCircle className="w-4 h-4 mr-1.5" /> : <AlertCircle className="w-4 h-4 mr-1.5" />}
                {isUpToDate ? 'À jour' : 'En retard'}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-px bg-slate-200">
              {MONTHS.map(m => (
                <div key={m} className="bg-white p-4 flex flex-col items-center justify-center gap-2">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{m}</span>
                  <span className={`text-lg font-bold ${yearPayments[m] ? 'text-slate-900' : 'text-slate-300'}`}>
                    {yearPayments[m] ? `${yearPayments[m]}` : '-'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <button 
              onClick={() => setHistoryModalMember(memberData)}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-xl hover:bg-degha-green hover:text-white hover:border-degha-green transition-all shadow-sm font-bold text-sm"
            >
              <Clock className="w-4 h-4" />
              Voir l'historique des paiements
            </button>
          </div>
        </div>

        {/* History Modal for Member */}
        <AnimatePresence>
          {historyModalMember && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm" onClick={() => setHistoryModalMember(null)}>
              <motion.div 
                initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                onClick={e => e.stopPropagation()}
                className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col max-h-[80vh]"
              >
                <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
                  <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                    <Clock className="w-5 h-5 text-blue-600" />
                    Historique - {historyModalMember.name}
                  </h3>
                  <button onClick={() => setHistoryModalMember(null)} className="text-slate-400 hover:text-slate-600 p-1 rounded-md hover:bg-slate-200 transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div className="p-4 overflow-y-auto flex-1">
                  {historyModalMember.history && historyModalMember.history.length > 0 ? (
                    <div className="space-y-4">
                      {[...historyModalMember.history].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).map(tx => (
                        <div key={tx.id} className="flex items-start gap-4 p-3 rounded-xl border border-slate-100 bg-slate-50/50">
                          <div className="bg-blue-100 text-blue-600 p-2 rounded-lg shrink-0">
                            <Wallet className="w-4 h-4" />
                          </div>
                          <div className="flex-1">
                            <p className="text-sm font-medium text-slate-900">Mise à jour : {tx.month} {tx.year}</p>
                            <p className="text-xs text-slate-500 mt-0.5">{new Date(tx.date).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-bold text-slate-900">{tx.amount === '' ? '0' : tx.amount} FCFA</p>
                            <p className="text-xs text-slate-400 line-through">{tx.previousAmount === '' ? '0' : tx.previousAmount} FCFA</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8 text-slate-500">
                      <Clock className="w-8 h-8 mx-auto mb-3 text-slate-300" />
                      <p>Aucun historique disponible pour ce membre.</p>
                    </div>
                  )}
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Floating Action Button for Export */}
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={exportToExcel}
          className="fixed bottom-8 right-8 z-50 bg-blue-600 text-white p-4 rounded-2xl shadow-2xl flex items-center gap-3 font-black uppercase tracking-wider hover:bg-blue-700 transition-colors border-4 border-white"
        >
          <Download className="w-6 h-6" />
          <span>Exporter vers Excel</span>
        </motion.button>
      </div>
    );
  }

  // Admin View
  return (
    <div className="min-h-screen bg-white text-slate-900 font-sans p-4 md:p-8 relative">
      {/* Vertical Stripes Motif */}
      <div className="fixed left-0 top-0 bottom-0 w-2 bg-degha-orange"></div>
      <div className="fixed left-2 top-0 bottom-0 w-2 bg-white"></div>
      <div className="fixed left-4 top-0 bottom-0 w-2 bg-degha-green"></div>

      <div className="max-w-[95vw] mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-white p-8 rounded-2xl shadow-lg border-l-8 border-degha-orange relative overflow-hidden">
          <div className="relative z-10">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-bold text-degha-orange uppercase tracking-widest">Administration Degha</span>
              <div className="h-px w-8 bg-degha-green"></div>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <h1 className="text-4xl font-black text-slate-900 tracking-tight">Cotisations Mensuelles</h1>
              <span className="text-[10px] bg-purple-900 text-white px-2 py-1 rounded-md font-mono font-bold animate-bounce">v8.6 - GESTION DES DÉPENSES</span>
              <button 
                onClick={() => {
                  setConfirmDialog({
                    isOpen: true,
                    title: "Nettoyage du cache",
                    message: "Voulez-vous forcer le nettoyage du cache et recharger la page ?",
                    isDanger: true,
                    onConfirm: () => {
                      if ('serviceWorker' in navigator) {
                        navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
                      }
                      if ('caches' in window) {
                        caches.keys().then(names => names.forEach(n => caches.delete(n)));
                      }
                      window.location.reload();
                    }
                  });
                }}
                className="text-[10px] bg-rose-100 text-rose-600 px-2 py-1 rounded-md hover:bg-rose-200 transition-colors"
              >
                Forcer la mise à jour
              </button>
              <div className="flex items-center gap-2 bg-slate-50 px-4 py-2 rounded-xl border border-slate-200">
                <Calendar className="w-5 h-5 text-slate-500" />
                <select 
                  value={currentYear} 
                  onChange={(e) => setCurrentYear(Number(e.target.value))}
                  className="bg-transparent outline-none text-lg font-bold text-degha-green cursor-pointer"
                >
                  {YEARS.map(y => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-slate-500 font-medium mt-1">WELARA • Objectif: 6 000 (Adhérent) - 12 000 (Cadre) FCFA/membre</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 mr-2">
              <input
                type="file"
                accept=".xlsx,.xls,.csv,.pdf"
                ref={fileInputRef}
                onChange={handleFileUpload}
                className="hidden"
              />
              <button 
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isImporting}
                className="bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-3 py-2 rounded-lg flex items-center gap-2 text-sm font-bold transition-all disabled:opacity-50 cursor-pointer hover:border-degha-orange hover:text-degha-orange shadow-sm"
              >
                {isImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {isImporting ? 'Importation...' : 'Importer'}
              </button>
            </div>
            
            <button 
              type="button"
              onClick={() => {
                setConfirmDialog({
                  isOpen: true,
                  title: "Réorganiser les paiements",
                  message: "Voulez-vous réorganiser TOUS les paiements de ce membre pour combler les retards chronologiquement ?",
                  isDanger: true,
                  onConfirm: async () => {
                    const batch = writeBatch(db);
                    members.forEach(m => {
                      const redistributed = redistributePayments(m.payments);
                      batch.update(doc(db, 'members', m.id), { payments: redistributed });
                    });
                    await batch.commit();
                  }
                });
              }}
              className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-2 rounded-lg flex items-center gap-2 text-sm font-bold transition-all cursor-pointer border border-slate-300 shadow-sm"
              title="Réorganiser les paiements pour combler les mois vides dans l'ordre"
            >
              <RefreshCw className="w-4 h-4" />
              Réorganiser
            </button>

            <button 
              type="button"
              onClick={exportToExcel}
              className="bg-degha-orange hover:bg-white text-white hover:text-degha-orange px-3 py-2 rounded-lg flex items-center gap-2 text-sm font-bold transition-all cursor-pointer border border-transparent hover:border-degha-orange shadow-sm"
            >
              <Download className="w-4 h-4" />
              Exporter vers Excel
            </button>

            <button 
              type="button"
              onClick={() => {
                setConfirmDialog({
                  isOpen: true,
                  title: "Remise à zéro complète",
                  message: "⚠️ ATTENTION : Cette action va effacer TOUS les paiements et TOUT l'historique de TOUS les membres. Cette commande est irréversible.\n\nÊtes-vous ABSOLUMENT sûr ? Tous les compteurs reviendront à zéro.",
                  isDanger: true,
                  onConfirm: async () => {
                    try {
                      const batch = writeBatch(db);
                      members.forEach(m => {
                        batch.update(doc(db, 'members', m.id), { 
                          payments: {},
                          history: []
                        });
                      });
                      await batch.commit();
                    } catch (error) {
                      console.error("Erreur lors du reset:", error);
                    }
                  }
                });
              }}
              className="bg-rose-50 hover:bg-rose-600 text-rose-600 hover:text-white px-3 py-2 rounded-lg flex items-center gap-2 text-sm font-bold transition-all cursor-pointer border border-rose-200 hover:border-rose-600 shadow-sm"
              title="Remettre tous les compteurs à zéro"
            >
              <Trash2 className="w-4 h-4" />
              Remise à Zéro
            </button>

            <form onSubmit={handleAddMember} className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Nouveau membre..."
                value={newMemberName}
                onChange={(e) => setNewMemberName(e.target.value)}
                className="px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm w-48 bg-white"
              />
              <select
                value={newMemberCategory}
                onChange={(e) => setNewMemberCategory(e.target.value as MemberCategory)}
                className="px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm bg-white cursor-pointer"
              >
                <option value="Adhérent">Adhérent</option>
                <option value="Cadre">Cadre</option>
              </select>
              <button 
                type="submit"
                className="bg-degha-green hover:bg-white text-white hover:text-degha-green px-4 py-2 rounded-lg flex items-center gap-1 text-sm font-bold transition-all border border-transparent hover:border-degha-green cursor-pointer shadow-sm"
              >
                <Plus className="w-4 h-4" />
                Ajouter
              </button>
            </form>
            <button 
              onClick={handleLogout} 
              className="ml-2 bg-slate-100 hover:bg-degha-orange text-slate-600 hover:text-white p-3 rounded-xl transition-all border border-slate-200 hover:border-degha-orange shadow-sm"
              title="Déconnexion"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Dashboard Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-6">
          <div className="bg-white p-6 rounded-xl shadow-sm border-l-4 border-degha-orange flex items-center gap-4">
            <div className="p-3 bg-orange-50 text-degha-orange rounded-lg">
              <Wallet className="w-8 h-8" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-500">Total Cotisations</p>
              <p className="text-2xl font-bold text-slate-900">{stats.totalCollected.toLocaleString()} FCFA</p>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border-l-4 border-emerald-500 flex items-center gap-4">
            <div className="p-3 bg-emerald-50 text-emerald-500 rounded-lg">
              <TrendingUp className="w-8 h-8" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-500">Entrées Exceptionnelles</p>
              <p className="text-2xl font-bold text-slate-900">{stats.totalRevenues.toLocaleString()} FCFA</p>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border-l-4 border-rose-500 flex items-center gap-4">
            <div className="p-3 bg-rose-50 text-rose-500 rounded-lg">
              <TrendingDown className="w-8 h-8" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-500">Total Dépenses</p>
              <p className="text-2xl font-bold text-slate-900">{stats.totalExpenses.toLocaleString()} FCFA</p>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border-l-4 border-degha-green flex items-center gap-4">
            <div className="p-3 bg-green-50 text-degha-green rounded-lg">
              <DollarSign className="w-8 h-8" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-500">Solde Restant</p>
              <p className={`text-2xl font-bold ${stats.netSolde >= 0 ? 'text-degha-green' : 'text-rose-600'}`}>
                {stats.netSolde.toLocaleString()} FCFA
              </p>
            </div>
          </div>
          
          <div className="bg-white p-6 rounded-xl shadow-sm border-l-4 border-blue-500 flex items-center gap-4">
            <div className="p-3 bg-blue-50 text-blue-500 rounded-lg">
              <CheckCircle className="w-8 h-8" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-500">Membres à jour</p>
              <p className="text-2xl font-bold text-slate-900">{stats.upToDateCount} / {members.length}</p>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border-l-4 border-slate-900 flex items-center gap-4">
             <div className="p-3 bg-slate-100 text-slate-900 rounded-lg">
              <Users className="w-8 h-8" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-500">Total Membres</p>
              <p className="text-2xl font-bold text-slate-900">{members.length}</p>
            </div>
          </div>
        </div>

        {/* Tab Switcher */}
        <div className="flex overflow-x-auto whitespace-nowrap border-b border-slate-200 gap-2 sm:gap-4 pb-1">
          <button
            onClick={() => setActiveAdminTab('members')}
            className={`px-3 sm:px-4 py-2.5 font-bold text-sm border-b-2 transition-all flex items-center gap-2 cursor-pointer shrink-0 ${
              activeAdminTab === 'members'
                ? 'border-degha-orange text-degha-orange bg-orange-50/10'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Users className="w-4 h-4" />
            Membres & Cotisations
          </button>
          <button
            onClick={() => setActiveAdminTab('revenues')}
            className={`px-3 sm:px-4 py-2.5 font-bold text-sm border-b-2 transition-all flex items-center gap-2 cursor-pointer shrink-0 ${
              activeAdminTab === 'revenues'
                ? 'border-degha-orange text-degha-orange bg-orange-50/10'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <TrendingUp className="w-4 h-4" />
            Entrées Exceptionnelles
          </button>
          <button
            onClick={() => setActiveAdminTab('expenses')}
            className={`px-3 sm:px-4 py-2.5 font-bold text-sm border-b-2 transition-all flex items-center gap-2 cursor-pointer shrink-0 ${
              activeAdminTab === 'expenses'
                ? 'border-degha-orange text-degha-orange bg-orange-50/10'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <TrendingDown className="w-4 h-4" />
            Gestion des Dépenses
          </button>
        </div>

        {activeAdminTab === 'members' ? (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50">
            <h2 className="text-lg font-semibold text-slate-800">Détails des paiements</h2>
            <div className="flex flex-col sm:flex-row flex-wrap gap-3 w-full sm:w-auto">
              <div className="relative w-full sm:w-auto">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Rechercher un membre..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-sm w-full sm:w-64 bg-white"
                />
              </div>
              <div className="relative w-full sm:w-auto">
                <Filter className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as any)}
                  className="pl-9 pr-8 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-sm w-full sm:w-auto bg-white appearance-none cursor-pointer"
                >
                  <option value="ALL">Statut annuel</option>
                  <option value="UP_TO_DATE">À jour (Année)</option>
                  <option value="LATE">En retard (Année)</option>
                </select>
              </div>
              <div className="relative w-full sm:w-auto">
                <Calendar className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <select
                  value={memberMonthFilter}
                  onChange={(e) => {
                    setMemberMonthFilter(e.target.value as any);
                    if (e.target.value === 'ALL') setMemberMonthStatus('ALL');
                  }}
                  className="pl-9 pr-8 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-sm w-full sm:w-auto bg-white appearance-none cursor-pointer"
                >
                  <option value="ALL">Tous les mois</option>
                  {MONTHS.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              {memberMonthFilter !== 'ALL' && (
                <div className="relative w-full sm:w-auto">
                  <Filter className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <select
                    value={memberMonthStatus}
                    onChange={(e) => setMemberMonthStatus(e.target.value as any)}
                    className="pl-9 pr-8 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-sm w-full sm:w-auto bg-white appearance-none cursor-pointer"
                  >
                    <option value="ALL">Statut ({memberMonthFilter})</option>
                    <option value="PAID">A payé</option>
                    <option value="UNPAID">N'a pas payé</option>
                  </select>
                </div>
              )}
            </div>
          </div>
          
          <div className="overflow-x-auto overflow-y-auto max-h-[60vh] relative">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 sticky top-0 z-20 shadow-[0_1px_0_0_#e2e8f0]">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-bold text-degha-green uppercase tracking-wider sticky left-0 top-0 bg-slate-50 z-30 shadow-[1px_0_0_0_#e2e8f0] max-w-[120px] sm:max-w-[200px] md:max-w-none truncate" title="Nom & Prénoms">
                    Nom & Prénoms
                  </th>
                  <th scope="col" className="px-4 py-3 text-center text-xs font-semibold text-slate-600 uppercase tracking-wider bg-slate-50">
                    Catégorie
                  </th>
                  <th scope="col" className="px-4 py-3 text-center text-xs font-semibold text-slate-600 uppercase tracking-wider bg-slate-50">
                    Code d'accès
                  </th>
                  {MONTHS.map(m => (
                    <th key={m} scope="col" className="px-2 py-3 text-center text-xs font-semibold text-slate-600 uppercase tracking-wider bg-slate-50">
                      {m}
                    </th>
                  ))}
                  <th scope="col" className="px-4 py-3 text-center text-xs font-semibold text-slate-600 uppercase tracking-wider bg-slate-50">
                    Total Annuel
                  </th>
                  <th scope="col" className="px-4 py-3 text-center text-xs font-semibold text-slate-600 uppercase tracking-wider bg-slate-50">
                    Reste à payer
                  </th>
                  <th scope="col" className="px-4 py-3 text-center text-xs font-semibold text-slate-600 uppercase tracking-wider bg-slate-50">
                    Statut
                  </th>
                  <th scope="col" className="px-4 py-3 text-center text-xs font-semibold text-slate-600 uppercase tracking-wider bg-slate-50">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                <AnimatePresence mode="popLayout">
                {filteredMembers.length > 0 ? (
                  filteredMembers.map((member, index) => {
                    const annualTarget = CATEGORY_ANNUAL_TARGET[member.category || 'Adhérent'];
                    const total = calculateTotal(member.payments, currentYear);
                    const reste = Math.max(0, annualTarget - total);
                    const isUpToDate = total >= annualTarget;
                    const yearPayments = member.payments[currentYear] || createEmptyYear();

                    return (
                      <motion.tr 
                        key={`${member.id}-${currentYear}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3, delay: index * 0.03 }}
                        className="hover:bg-orange-50/40 transition-all duration-300 ease-in-out group"
                      >
                        <td 
                          className="px-4 py-3 whitespace-nowrap text-sm font-medium text-slate-900 sticky left-0 bg-white group-hover:bg-orange-50/40 z-10 shadow-[1px_0_0_0_#e2e8f0] transition-all duration-300 ease-in-out relative cursor-pointer group/name"
                          onMouseEnter={() => speakName(member.name)}
                          onMouseLeave={stopSpeaking}
                        >
                          <div className="absolute left-0 top-0 bottom-0 w-1 bg-degha-orange scale-y-0 group-hover:scale-y-100 transition-transform duration-300 ease-in-out origin-center" />
                          <div className="truncate max-w-[120px] sm:max-w-[200px] md:max-w-[250px] lg:max-w-none" title={member.name}>
                            {member.name}
                          </div>
                          
                          {/* Custom Tooltip (Desktop) */}
                          <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-3 py-1.5 bg-slate-800 text-white text-xs font-bold rounded-md shadow-lg opacity-0 invisible group-hover/name:opacity-100 group-hover/name:visible transition-all duration-200 z-50 whitespace-nowrap hidden md:flex items-center gap-2 pointer-events-none">
                            {member.name}
                            <div className="absolute top-1/2 -left-1 -translate-y-1/2 w-2 h-2 bg-slate-800 rotate-45" />
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-center bg-slate-50/30 group-hover:bg-orange-50/20 transition-colors duration-300">
                          <select
                            value={member.category || 'Adhérent'}
                            onChange={(e) => handleCategoryChange(member.id, e.target.value as MemberCategory)}
                            className={`text-xs font-bold px-2 py-1 rounded-md border outline-none cursor-pointer transition-all ${
                              (member.category || 'Adhérent') === 'Cadre' 
                                ? 'bg-indigo-50 text-indigo-700 border-indigo-200' 
                                : 'bg-slate-50 text-slate-700 border-slate-200'
                            }`}
                          >
                            <option value="Adhérent">Adhérent</option>
                            <option value="Cadre">Cadre</option>
                          </select>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-center font-mono font-bold text-slate-500 bg-slate-50/30">
                          {member.id}
                        </td>
                        {MONTHS.map(m => {
                          const breakdown = getPaymentBreakdown(member, currentYear, m);
                          return (
                            <td key={m} className="px-2 py-3 whitespace-nowrap text-center">
                              <PaymentCell
                                initialValue={yearPayments[m]}
                                onSave={(val) => handlePaymentChange(member.id, currentYear, m, val)}
                              />
                              {breakdown && (
                                <div className="mt-1 text-[9px] font-bold text-rose-500 leading-none">
                                  {breakdown.recoveredYear < currentYear ? (
                                    <span>→ {breakdown.recoveredYear}</span>
                                  ) : (
                                    <span>Rattrap.</span>
                                  )}
                                </div>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-center font-bold text-slate-700 bg-slate-50/30 group-hover:bg-orange-50/20 transition-colors duration-300">
                          {total.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-center font-medium bg-slate-50/30 group-hover:bg-orange-50/20 transition-colors duration-300">
                          <span className={reste > 0 ? 'text-rose-600' : 'text-slate-400'}>
                            {reste > 0 ? reste.toLocaleString() : '-'}
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-center bg-slate-50/30 group-hover:bg-orange-50/20 transition-colors duration-300">
                          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${
                            isUpToDate 
                              ? 'bg-green-50 text-degha-green border-green-200' 
                              : 'bg-orange-50 text-degha-orange border-orange-200'
                          }`}>
                            {isUpToDate ? <CheckCircle className="w-3.5 h-3.5 mr-1" /> : <AlertCircle className="w-3.5 h-3.5 mr-1" />}
                            {isUpToDate ? 'À jour' : 'En retard'}
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-center bg-slate-50/30 group-hover:bg-orange-50/20 transition-colors duration-300">
                          <div className="flex items-center justify-center gap-2">
                            <button 
                              onClick={() => setHistoryModalMember(member)}
                              className="text-slate-400 hover:text-degha-green transition-all p-1.5 rounded-md hover:bg-green-50"
                              title="Historique des paiements"
                            >
                              <Clock className="w-4 h-4" />
                            </button>
                            <button 
                              onClick={() => handleDeleteMember(member.id)}
                              className="text-slate-400 hover:text-degha-orange transition-all p-1.5 rounded-md hover:bg-orange-50"
                              title="Supprimer le membre"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </motion.tr>
                    );
                  })
                ) : (
                  <motion.tr initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <td colSpan={19} className="px-4 py-8 text-center text-slate-500 text-sm">
                      Aucun membre trouvé.
                    </td>
                  </motion.tr>
                )}
                </AnimatePresence>
              </tbody>
              <tfoot className="bg-slate-50 font-bold sticky bottom-0 z-20 shadow-[0_-2px_0_0_#e2e8f0]">
                {/* Total Cotisations */}
                <tr className="border-b border-slate-100">
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs font-black text-degha-orange sticky left-0 bg-slate-50 z-30 shadow-[1px_0_0_0_#e2e8f0] max-w-[120px] sm:max-w-[200px] md:max-w-none truncate" title="Total Mensuel (Paiements)">
                    Total Cotisations Mensuelles
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-center font-mono font-bold text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  {MONTHS.map(m => (
                    <td key={m} className="px-2 py-2.5 whitespace-nowrap text-center text-xs font-black text-slate-800 bg-slate-50/50">
                      {monthlyTotals[m] > 0 ? monthlyTotals[m].toLocaleString() : '-'}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-center font-black text-degha-green bg-slate-50/50">
                    {grandTotal.toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-center font-black text-rose-600 bg-slate-50/50">
                    {totalReste > 0 ? totalReste.toLocaleString() : '-'}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                </tr>

                {/* Entrées Exceptionnelles */}
                <tr className="border-b border-slate-100">
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs font-black text-emerald-600 sticky left-0 bg-slate-50 z-30 shadow-[1px_0_0_0_#e2e8f0] max-w-[120px] sm:max-w-[200px] md:max-w-none truncate" title="Entrées Exceptionnelles">
                    Entrées Exceptionnelles
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-center font-mono font-bold text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  {MONTHS.map(m => (
                    <td key={m} className="px-2 py-2.5 whitespace-nowrap text-center text-xs font-black text-emerald-600 bg-slate-50/50">
                      {monthlyRevenues[m] > 0 ? `+${monthlyRevenues[m].toLocaleString()}` : '-'}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-center font-black text-emerald-600 bg-slate-50/50">
                    {grandTotalRevenues > 0 ? `+${grandTotalRevenues.toLocaleString()}` : '-'}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                </tr>

                {/* Total Dépenses */}
                <tr className="border-b border-slate-100">
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs font-black text-rose-500 sticky left-0 bg-slate-50 z-30 shadow-[1px_0_0_0_#e2e8f0] max-w-[120px] sm:max-w-[200px] md:max-w-none truncate" title="Dépenses Mensuelles">
                    Dépenses Mensuelles
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-center font-mono font-bold text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  {MONTHS.map(m => (
                    <td key={m} className="px-2 py-2.5 whitespace-nowrap text-center text-xs font-black text-rose-500 bg-slate-50/50">
                      {monthlyExpenses[m] > 0 ? `-${monthlyExpenses[m].toLocaleString()}` : '-'}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-center font-black text-rose-600 bg-slate-50/50">
                    {grandTotalExpenses > 0 ? `-${grandTotalExpenses.toLocaleString()}` : '-'}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                </tr>

                {/* Solde Net */}
                <tr>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs font-black text-degha-green sticky left-0 bg-slate-50 z-30 shadow-[1px_0_0_0_#e2e8f0] max-w-[120px] sm:max-w-[200px] md:max-w-none truncate" title="Solde Net (Caisse)">
                    Solde Net (Caisse)
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-center font-mono font-bold text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  {MONTHS.map(m => {
                    const monthlyNet = (monthlyTotals[m] || 0) + (monthlyRevenues[m] || 0) - (monthlyExpenses[m] || 0);
                    return (
                      <td key={m} className={`px-2 py-2.5 whitespace-nowrap text-center text-xs font-black bg-slate-50/50 ${
                        monthlyNet >= 0 ? 'text-degha-green' : 'text-rose-600'
                      }`}>
                        {monthlyNet !== 0 ? monthlyNet.toLocaleString() : '-'}
                      </td>
                    );
                  })}
                  <td className={`px-4 py-2.5 whitespace-nowrap text-xs text-center font-black bg-slate-50/50 ${
                    netBalance >= 0 ? 'text-degha-green' : 'text-rose-600'
                  }`}>
                    {netBalance.toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-slate-400 bg-slate-50/50">
                    -
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        ) : activeAdminTab === 'revenues' ? (
          /* Revenues Section (Entrées Exceptionnelles) */
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Form to Add Revenue */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-6 h-fit">
              <h2 className="text-lg font-bold text-slate-900 border-b pb-3 flex items-center gap-2">
                <Plus className="w-5 h-5 text-degha-orange" />
                Enregistrer une entrée exceptionnelle
              </h2>
              <form onSubmit={handleAddRevenue} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Détails de l'entrée</label>
                  <textarea
                    required
                    value={revenueDesc}
                    onChange={(e) => setRevenueDesc(e.target.value)}
                    placeholder="Ex: Subvention, Don exceptionnel, Vente de matériel..."
                    rows={3}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-sm bg-white resize-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Mois</label>
                    <select
                      value={revenueMonth}
                      onChange={(e) => setRevenueMonth(e.target.value as Month)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-sm bg-white cursor-pointer"
                    >
                      {MONTHS.map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Année</label>
                    <select
                      value={revenueYear}
                      onChange={(e) => setRevenueYear(Number(e.target.value))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-sm bg-white cursor-pointer"
                    >
                      {YEARS.map(y => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Montant (FCFA)</label>
                  <div className="relative">
                    <input
                      type="number"
                      required
                      min="1"
                      value={revenueAmount}
                      onChange={(e) => setRevenueAmount(e.target.value)}
                      placeholder="Ex: 10000"
                      className="w-full pl-3 pr-16 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-sm bg-white"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">
                      FCFA
                    </span>
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full bg-degha-green hover:bg-white text-white hover:text-degha-green font-bold py-2.5 rounded-lg border border-transparent hover:border-degha-green transition-all shadow-sm flex items-center justify-center gap-2 text-sm cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  Enregistrer l'entrée
                </button>
              </form>
            </div>

            {/* List of Revenues */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 lg:col-span-2 flex flex-col min-h-[400px]">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b pb-4 mb-4">
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-emerald-500" />
                  Historique des entrées exceptionnelles ({currentYear})
                </h2>
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-slate-400" />
                  <select
                    value={revenueFilterMonth}
                    onChange={(e) => setRevenueFilterMonth(e.target.value as any)}
                    className="px-3 py-1.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-xs bg-white cursor-pointer"
                  >
                    <option value="ALL">Tous les mois</option>
                    {MONTHS.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex-1 overflow-x-auto">
                {(() => {
                  const filteredRevenues = revenues
                    .filter(rev => rev.year === currentYear)
                    .filter(rev => revenueFilterMonth === 'ALL' || rev.month === revenueFilterMonth)
                    .sort((a, b) => new Date(b.createdAt || '').getTime() - new Date(a.createdAt || '').getTime());

                  if (filteredRevenues.length === 0) {
                    return (
                      <div className="text-center py-16 text-slate-500">
                        <TrendingUp className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                        <p className="font-bold">Aucune entrée enregistrée.</p>
                        <p className="text-sm text-slate-400 mt-1">
                          {revenueFilterMonth === 'ALL'
                            ? `Aucune entrée enregistrée pour l'année ${currentYear}.`
                            : `Aucune entrée enregistrée en ${revenueFilterMonth} ${currentYear}.`}
                        </p>
                      </div>
                    );
                  }

                  return (
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-400 text-xs font-bold uppercase">
                          <th className="py-2.5">Période</th>
                          <th className="py-2.5">Description</th>
                          <th className="py-2.5 text-right">Montant</th>
                          <th className="py-2.5 text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-sm">
                        {filteredRevenues.map((rev) => (
                          <tr key={rev.id} className="hover:bg-slate-50/50">
                            <td className="py-3 font-semibold text-slate-700">
                              <span className="bg-slate-100 text-slate-800 text-xs px-2 py-1 rounded">
                                {rev.month} {rev.year}
                              </span>
                            </td>
                            <td className="py-3">
                              <p className="font-medium text-slate-900">{rev.description}</p>
                              {rev.createdAt && (
                                <p className="text-[10px] text-slate-400 mt-0.5">
                                  Enregistré le {new Date(rev.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
                                </p>
                              )}
                            </td>
                            <td className="py-3 text-right font-bold text-emerald-600">
                              +{rev.amount.toLocaleString()} FCFA
                            </td>
                            <td className="py-3 text-center">
                              <button
                                onClick={() => handleDeleteRevenue(rev.id)}
                                className="text-rose-600 hover:bg-rose-50 p-1.5 rounded-lg transition-colors cursor-pointer"
                                title="Supprimer l'entrée"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  );
                })()}
              </div>
            </div>
          </div>
        ) : (
          /* Expenses Section */
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Form to Add Expense */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-6 h-fit">
              <h2 className="text-lg font-bold text-slate-900 border-b pb-3 flex items-center gap-2">
                <Plus className="w-5 h-5 text-degha-orange" />
                Enregistrer une dépense
              </h2>
              <form onSubmit={handleAddExpense} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Détails de la dépense</label>
                  <textarea
                    required
                    value={expenseDesc}
                    onChange={(e) => setExpenseDesc(e.target.value)}
                    placeholder="Ex: Achat de fournitures, Facture électricité..."
                    rows={3}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-sm bg-white resize-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Mois</label>
                    <select
                      value={expenseMonth}
                      onChange={(e) => setExpenseMonth(e.target.value as Month)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-sm bg-white cursor-pointer"
                    >
                      {MONTHS.map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Année</label>
                    <select
                      value={expenseYear}
                      onChange={(e) => setExpenseYear(Number(e.target.value))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-sm bg-white cursor-pointer"
                    >
                      {YEARS.map(y => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Montant (FCFA)</label>
                  <div className="relative">
                    <input
                      type="number"
                      required
                      min="1"
                      value={expenseAmount}
                      onChange={(e) => setExpenseAmount(e.target.value)}
                      placeholder="Ex: 5000"
                      className="w-full pl-3 pr-16 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-sm bg-white"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">
                      FCFA
                    </span>
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full bg-degha-green hover:bg-white text-white hover:text-degha-green font-bold py-2.5 rounded-lg border border-transparent hover:border-degha-green transition-all shadow-sm flex items-center justify-center gap-2 text-sm cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  Enregistrer la dépense
                </button>
              </form>
            </div>

            {/* List of Expenses */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 lg:col-span-2 flex flex-col min-h-[400px]">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b pb-4 mb-4">
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <TrendingDown className="w-5 h-5 text-rose-500" />
                  Historique des dépenses ({currentYear})
                </h2>
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-slate-400" />
                  <select
                    value={expenseFilterMonth}
                    onChange={(e) => setExpenseFilterMonth(e.target.value as any)}
                    className="px-3 py-1.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-degha-green focus:border-degha-green outline-none text-xs bg-white cursor-pointer"
                  >
                    <option value="ALL">Tous les mois</option>
                    {MONTHS.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex-1 overflow-x-auto">
                {(() => {
                  const filteredExpenses = expenses
                    .filter(exp => exp.year === currentYear)
                    .filter(exp => expenseFilterMonth === 'ALL' || exp.month === expenseFilterMonth)
                    .sort((a, b) => new Date(b.createdAt || '').getTime() - new Date(a.createdAt || '').getTime());

                  if (filteredExpenses.length === 0) {
                    return (
                      <div className="text-center py-16 text-slate-500">
                        <TrendingDown className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                        <p className="font-bold">Aucune dépense enregistrée.</p>
                        <p className="text-sm text-slate-400 mt-1">
                          {expenseFilterMonth === 'ALL'
                            ? `Aucune dépense enregistrée pour l'année ${currentYear}.`
                            : `Aucune dépense enregistrée en ${expenseFilterMonth} ${currentYear}.`}
                        </p>
                      </div>
                    );
                  }

                  return (
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-400 text-xs font-bold uppercase">
                          <th className="py-2.5">Période</th>
                          <th className="py-2.5">Description</th>
                          <th className="py-2.5 text-right">Montant</th>
                          <th className="py-2.5 text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-sm">
                        {filteredExpenses.map((exp) => (
                          <tr key={exp.id} className="hover:bg-slate-50/50">
                            <td className="py-3 font-semibold text-slate-700">
                              <span className="bg-slate-100 text-slate-800 text-xs px-2 py-1 rounded">
                                {exp.month} {exp.year}
                              </span>
                            </td>
                            <td className="py-3">
                              <p className="font-medium text-slate-900">{exp.description}</p>
                              <p className="text-[10px] text-slate-400 mt-0.5">
                                Enregistré le {new Date(exp.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
                              </p>
                            </td>
                            <td className="py-3 text-right font-bold text-rose-600">
                              -{exp.amount.toLocaleString()} FCFA
                            </td>
                            <td className="py-3 text-center">
                              <button
                                onClick={() => handleDeleteExpense(exp.id)}
                                className="text-rose-600 hover:bg-rose-50 p-1.5 rounded-lg transition-colors cursor-pointer"
                                title="Supprimer la dépense"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  );
                })()}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* History Modal for Admin */}
      <AnimatePresence>
        {historyModalMember && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm" onClick={() => setHistoryModalMember(null)}>
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col max-h-[80vh]"
            >
              <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50 border-l-8 border-degha-green">
                <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                  <Clock className="w-5 h-5 text-degha-green" />
                  Historique - {historyModalMember.name}
                </h3>
                <button onClick={() => setHistoryModalMember(null)} className="text-slate-400 hover:text-slate-600 p-1 rounded-md hover:bg-slate-200 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-4 overflow-y-auto flex-1">
                {historyModalMember.history && historyModalMember.history.length > 0 ? (
                  <div className="space-y-4">
                    {[...historyModalMember.history].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).map(tx => (
                      <div key={tx.id} className="flex items-start gap-4 p-3 rounded-xl border border-slate-100 bg-slate-50/50 border-l-4 border-degha-orange">
                        <div className="bg-orange-100 text-degha-orange p-2 rounded-lg shrink-0">
                          <Wallet className="w-4 h-4" />
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-medium text-slate-900">Mise à jour : {tx.month} {tx.year}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{new Date(tx.date).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-bold text-slate-900">{tx.amount === '' ? '0' : tx.amount} FCFA</p>
                          <p className="text-xs text-slate-400 line-through">{tx.previousAmount === '' ? '0' : tx.previousAmount} FCFA</p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-slate-500">
                    <Clock className="w-8 h-8 mx-auto mb-3 text-slate-300" />
                    <p>Aucun historique disponible pour ce membre.</p>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Global Confirmation Dialog */}
      <AnimatePresence>
        {confirmDialog && confirmDialog.isOpen && (
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-sm overflow-hidden"
            >
              <div className={`p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50 border-l-8 ${confirmDialog.isDanger ? 'border-rose-500' : 'border-degha-orange'}`}>
                <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                  <AlertCircle className={`w-5 h-5 ${confirmDialog.isDanger ? 'text-rose-500' : 'text-degha-orange'}`} />
                  {confirmDialog.title}
                </h3>
              </div>
              <div className="p-5">
                <p className="text-slate-600 text-sm whitespace-pre-line leading-relaxed">
                  {confirmDialog.message}
                </p>
                <div className="mt-6 flex justify-end gap-3">
                  <button
                    onClick={() => setConfirmDialog(null)}
                    className="px-4 py-2 text-sm font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                  >
                    Annuler
                  </button>
                  <button
                    onClick={() => {
                      confirmDialog.onConfirm();
                      setConfirmDialog(null);
                    }}
                    className={`px-4 py-2 text-sm font-bold text-white rounded-lg transition-colors ${confirmDialog.isDanger ? 'bg-rose-500 hover:bg-rose-600' : 'bg-degha-orange hover:bg-orange-600'}`}
                  >
                    Confirmer
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
