import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Me } from "../services/api";

export type Register = {
  full_name: string;
  email: string;
  password: string;
  school_name: string;
};
export type Credentials = { email: string; password: string };
export type RegisterResponse = {
  requires_verification: boolean;
  message: string;
  verification_path?: string | null;
};
type AuthContextValue = {
  user: Me | null;
  loading: boolean;
  login: (data: Credentials) => Promise<Me>;
  register: (data: Register) => Promise<RegisterResponse>;
  verifyEmail: (token: string) => Promise<Me>;
  acceptInvitation: (data: {
    token: string;
    full_name: string;
    password: string;
  }) => Promise<Me>;
  logout: () => Promise<void>;
  updateProfile: (full_name: string) => Promise<Me>;
};
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const session = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/auth/me"),
    retry: false,
    staleTime: 30_000,
  });
  const loginMutation = useMutation({
    mutationFn: (data: Credentials) =>
      api<Me>("/auth/login", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: (user) => client.setQueryData(["me"], user),
  });
  const registerMutation = useMutation({
    mutationFn: (data: Register) =>
      api<RegisterResponse>("/auth/register", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
  const verifyMutation = useMutation({
    mutationFn: (token: string) =>
      api<Me>("/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    onSuccess: (user) => client.setQueryData(["me"], user),
  });
  const inviteMutation = useMutation({
    mutationFn: (data: {
      token: string;
      full_name: string;
      password: string;
    }) =>
      api<Me>("/staff/invitations/accept", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const logoutMutation = useMutation({
    mutationFn: () => api<void>("/auth/logout", { method: "POST" }),
    onSuccess: () => client.setQueryData(["me"], null),
  });
  const profileMutation = useMutation({
    mutationFn: (full_name: string) =>
      api<Me>("/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ full_name }),
      }),
    onSuccess: (user) => client.setQueryData(["me"], user),
  });
  const value = useMemo<AuthContextValue>(
    () => ({
      user: session.data ?? null,
      loading: session.isPending,
      login: (data) => loginMutation.mutateAsync(data),
      register: (data) => registerMutation.mutateAsync(data),
      verifyEmail: (token) => verifyMutation.mutateAsync(token),
      acceptInvitation: (data) => inviteMutation.mutateAsync(data),
      logout: () => logoutMutation.mutateAsync(),
      updateProfile: (name) => profileMutation.mutateAsync(name),
    }),
    [
      session.data,
      session.isPending,
      loginMutation,
      registerMutation,
      verifyMutation,
      inviteMutation,
      logoutMutation,
      profileMutation,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
