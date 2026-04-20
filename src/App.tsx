import React, { useState, useEffect, useMemo, useRef, Component } from 'react';
import Papa from 'papaparse';
import { CheckCircle, AlertCircle, Users, Wallet, Plus, Search, Upload, Loader2, Calendar, LogIn, Key, LogOut, Trash2, Filter, Clock, X, Download, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import { GoogleGenAI, Type } from '@google/genai';
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
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberCategory, setNewMemberCategory] = useState<MemberCategory>('Adhérent');
  const [isImporting, setIsImporting] = useState(false);
  const [currentYear, setCurrentYear] = useState<number>(new Date().getFullYear() >= 2025 && new Date().getFullYear() <= 2030 ? new Date().getFullYear() : 2025);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [historyModalMember, setHistoryModalMember] = useState<Member | null>(null);

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

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Clé API Gemini manquante");

    const ai = new GoogleGenAI({ apiKey });
    
    const response = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [
        {
          inlineData: {
            mimeType: "application/pdf",
            data: base64
          }
        },
        "Extrait les noms des membres et leurs cotisations mensuelles depuis ce document. Renvoie un tableau JSON d'objets. Chaque objet doit avoir un 'name' (chaîne de caractères) et un objet 'payments'. L'objet 'payments' doit avoir comme clés les mois : 'JAN', 'FEV', 'MARS', 'AVRIL', 'MAI', 'JUIN', 'JUILL', 'AOUT', 'SEP', 'OCT', 'NOV', 'DEC'. Les valeurs doivent être des nombres (le montant payé, mettez 0 si rien n'a été payé)."
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              payments: {
                type: Type.OBJECT,
                properties: {
                  JAN: { type: Type.NUMBER },
                  FEV: { type: Type.NUMBER },
                  MARS: { type: Type.NUMBER },
                  AVRIL: { type: Type.NUMBER },
                  MAI: { type: Type.NUMBER },
                  JUIN: { type: Type.NUMBER },
                  JUILL: { type: Type.NUMBER },
                  AOUT: { type: Type.NUMBER },
                  SEP: { type: Type.NUMBER },
                  OCT: { type: Type.NUMBER },
                  NOV: { type: Type.NUMBER },
                  DEC: { type: Type.NUMBER }
                }
              }
            },
            required: ["name", "payments"]
          }
        }
      }
    });

    const jsonStr = response.text;
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

    return { totalCollected, upToDateCount };
  }, [members, currentYear]);

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

  const handleDeleteMember = async (memberId: string) => {
    try {
      await deleteDoc(doc(db, 'members', memberId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `members/${memberId}`);
    }
  };

  const handleCategoryChange = async (memberId: string, category: MemberCategory) => {
    try {
      await updateDoc(doc(db, 'members', memberId), { category });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `members/${memberId}`);
    }
  };

  const filteredMembers = members.filter(m => {
    const matchesSearch = m.name.toLowerCase().includes(searchTerm.toLowerCase());
    if (!matchesSearch) return false;
    
    if (statusFilter === 'ALL') return true;
    
    const annualTarget = CATEGORY_ANNUAL_TARGET[m.category || 'Adhérent'];
    const total = calculateTotal(m.payments, currentYear);
    const isUpToDate = total >= annualTarget;
    
    if (statusFilter === 'UP_TO_DATE') return isUpToDate;
    if (statusFilter === 'LATE') return !isUpToDate;
    
    return true;
  });

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
              <span className="text-[10px] bg-purple-900 text-white px-2 py-1 rounded-md font-mono font-bold animate-bounce">v8.5 - CATÉGORIES MEMBRES</span>
              <button 
                onClick={() => {
                  if (confirm("Voulez-vous forcer le nettoyage du cache et recharger la page ?")) {
                    if ('serviceWorker' in navigator) {
                      navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
                    }
                    if ('caches' in window) {
                      caches.keys().then(names => names.forEach(n => caches.delete(n)));
                    }
                    window.location.reload();
                  }
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
              onClick={async () => {
                if (confirm("Voulez-vous réorganiser TOUS les paiements de ce membre pour combler les retards chronologiquement ?")) {
                  const batch = writeBatch(db);
                  members.forEach(m => {
                    const redistributed = redistributePayments(m.payments);
                    batch.update(doc(db, 'members', m.id), { payments: redistributed });
                  });
                  await batch.commit();
                  alert("Paiements réorganisés avec succès !");
                }
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
              onClick={async () => {
                if (confirm("⚠️ ATTENTION : Cette action va effacer TOUS les paiements et TOUT l'historique de TOUS les membres. Cette commande est irréversible.\n\nVoulez-vous continuer ?")) {
                  if (confirm("Êtes-vous ABSOLUMENT sûr ?\nTous les compteurs (Total Collecté, Membres à jour) reviendront à zéro.")) {
                    try {
                      const batch = writeBatch(db);
                      members.forEach(m => {
                        batch.update(doc(db, 'members', m.id), { 
                          payments: {},
                          history: []
                        });
                      });
                      await batch.commit();
                      alert("Toutes les données de paiement et d'historique ont été remises à zéro.");
                    } catch (error) {
                      console.error("Erreur lors du reset:", error);
                      alert("Une erreur est survenue lors de la réinitialisation.");
                    }
                  }
                }
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white p-6 rounded-xl shadow-sm border-l-4 border-degha-orange flex items-center gap-4">
            <div className="p-3 bg-orange-50 text-degha-orange rounded-lg">
              <Wallet className="w-8 h-8" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-500">Total Collecté</p>
              <p className="text-2xl font-bold text-slate-900">{stats.totalCollected.toLocaleString()} FCFA</p>
            </div>
          </div>
          
          <div className="bg-white p-6 rounded-xl shadow-sm border-l-4 border-degha-green flex items-center gap-4">
            <div className="p-3 bg-green-50 text-degha-green rounded-lg">
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

        {/* Table Section */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50">
            <h2 className="text-lg font-semibold text-slate-800">Détails des paiements</h2>
            <div className="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
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
                  <option value="ALL">Tous les statuts</option>
                  <option value="UP_TO_DATE">À jour</option>
                  <option value="LATE">En retard</option>
                </select>
              </div>
            </div>
          </div>
          
          <div className="overflow-x-auto overflow-y-auto max-h-[60vh] relative">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 sticky top-0 z-20 shadow-[0_1px_0_0_#e2e8f0]">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-bold text-degha-green uppercase tracking-wider sticky left-0 top-0 bg-slate-50 z-30 shadow-[1px_0_0_0_#e2e8f0]">
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
                          className="px-4 py-3 whitespace-nowrap text-sm font-medium text-slate-900 sticky left-0 bg-white group-hover:bg-orange-50/40 z-10 shadow-[1px_0_0_0_#e2e8f0] transition-all duration-300 ease-in-out relative cursor-pointer"
                          onMouseEnter={() => speakName(member.name)}
                          onMouseLeave={stopSpeaking}
                          title="Écouter le nom"
                        >
                          <div className="absolute left-0 top-0 bottom-0 w-1 bg-degha-orange scale-y-0 group-hover:scale-y-100 transition-transform duration-300 ease-in-out origin-center" />
                          {member.name}
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
            </table>
          </div>
        </div>
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
    </div>
  );
}
