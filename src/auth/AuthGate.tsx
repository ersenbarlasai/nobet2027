import {
  acceptInvite,
  AuthError,
  getUser,
  handleAuthCallback,
  login,
  logout,
  onAuthChange,
  updateUser,
  type User,
} from "@netlify/identity";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { AuthContext, type AuthContextValue } from "./AuthContext";
import "./AuthGate.css";

type AuthMode = "loading" | "login" | "invite" | "recovery" | "authenticated";

function authMessage(error: unknown): string {
  if (error instanceof AuthError) {
    if (error.status === 401) return "E-posta adresi veya parola hatalı.";
    if (error.status === 422) return "Bilgileri kontrol edip tekrar deneyin.";
    return error.message;
  }
  return "Oturum işlemi tamamlanamadı. Lütfen tekrar deneyin.";
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const localDevelopment = import.meta.env.DEV;
  const [mode, setMode] = useState<AuthMode>(localDevelopment ? "authenticated" : "loading");
  const [user, setUser] = useState<User | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordAgain, setPasswordAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (localDevelopment) return;
    let active = true;

    void (async () => {
      try {
        const callback = await handleAuthCallback();
        if (!active) return;
        if (callback?.type === "invite" && callback.token) {
          setInviteToken(callback.token);
          setMode("invite");
          return;
        }
        if (callback?.type === "recovery") {
          setUser(callback.user);
          setMode("recovery");
          return;
        }
        const currentUser = callback?.user ?? await getUser();
        setUser(currentUser);
        setMode(currentUser ? "authenticated" : "login");
      } catch (caught) {
        if (!active) return;
        setError(authMessage(caught));
        setMode("login");
      }
    })();

    const unsubscribe = onAuthChange((_event, currentUser) => {
      if (!active) return;
      setUser(currentUser);
      if (currentUser) setMode("authenticated");
      else setMode("login");
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [localDevelopment]);

  const contextValue = useMemo<AuthContextValue>(() => ({
    user,
    signOut: async () => {
      if (localDevelopment) return;
      await logout();
      setUser(null);
      setMode("login");
    },
  }), [localDevelopment, user]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "invite") {
        if (!inviteToken) throw new Error("Davet bağlantısı geçersiz.");
        if (password.length < 8) throw new Error("Parola en az 8 karakter olmalı.");
        if (password !== passwordAgain) throw new Error("Parolalar eşleşmiyor.");
        const acceptedUser = await acceptInvite(inviteToken, password);
        setUser(acceptedUser);
        setMode("authenticated");
      } else if (mode === "recovery") {
        if (password.length < 8) throw new Error("Parola en az 8 karakter olmalı.");
        if (password !== passwordAgain) throw new Error("Parolalar eşleşmiyor.");
        const updatedUser = await updateUser({ password });
        setUser(updatedUser);
        setMode("authenticated");
      } else {
        const loggedInUser = await login(email.trim(), password);
        setUser(loggedInUser);
        setMode("authenticated");
      }
      setPassword("");
      setPasswordAgain("");
    } catch (caught) {
      setError(authMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (mode === "loading") {
    return <div className="auth-loading" role="status">Güvenli oturum kontrol ediliyor…</div>;
  }

  if (mode === "authenticated") {
    return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
  }

  const settingPassword = mode === "invite" || mode === "recovery";
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-mark"><LockKeyhole size={24} aria-hidden="true" /></div>
        <p className="auth-eyebrow">NÖBET2027 · YÖNETİM PANELİ</p>
        <h1 id="auth-title">{settingPassword ? "Yönetici parolanızı belirleyin" : "Yönetici girişi"}</h1>
        <p className="auth-copy">
          {settingPassword
            ? "Güvenli hesabınızı etkinleştirmek için yeni parolanızı oluşturun."
            : "Okul planlama verilerine erişmek için yönetici hesabınızla giriş yapın."}
        </p>
        {error ? <div className="auth-error" role="alert">{error}</div> : null}
        <form onSubmit={submit} className="auth-form">
          {!settingPassword ? (
            <label>
              E-posta
              <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </label>
          ) : null}
          <label>
            {settingPassword ? "Yeni parola" : "Parola"}
            <input type="password" autoComplete={settingPassword ? "new-password" : "current-password"} minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {settingPassword ? (
            <label>
              Yeni parola tekrar
              <input type="password" autoComplete="new-password" minLength={8} value={passwordAgain} onChange={(event) => setPasswordAgain(event.target.value)} required />
            </label>
          ) : null}
          <button type="submit" disabled={busy}>{busy ? "İşleniyor…" : settingPassword ? "Hesabı etkinleştir" : "Giriş yap"}</button>
        </form>
        <p className="auth-footnote">Bu alan yalnızca yetkili yönetici hesabına açıktır.</p>
      </section>
    </main>
  );
}
