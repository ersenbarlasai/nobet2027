import { createContext, useContext } from "react";
import type { User } from "@netlify/identity";

export interface AuthContextValue {
  user: User | null;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  signOut: async () => undefined,
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
