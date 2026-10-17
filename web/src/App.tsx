import { Alert, AppShell, Badge, Burger, Button, Center, Group, Loader, NavLink, Paper, Stack, Text, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconAdjustments, IconChartBar, IconCode, IconHash, IconHistory, IconLogout, IconNotebook, IconTool } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, Route, Routes, useLocation } from "react-router";
import { api, setCsrfToken, type MeResponse } from "./api";
import { AuditPage } from "./pages/Audit";
import { ChannelDetailPage } from "./pages/ChannelDetail";
import { ChannelsPage } from "./pages/Channels";
import { CodingPage } from "./pages/Coding";
import { MemoriesPage } from "./pages/Memories";
import { SettingsPage } from "./pages/Settings";
import { ToolsPage } from "./pages/Tools";
import { UsagePage } from "./pages/Usage";

const NAV = [
  { to: "/channels", label: "Channels", icon: IconHash },
  { to: "/memories", label: "Memories", icon: IconNotebook },
  { to: "/usage", label: "Usage", icon: IconChartBar },
  { to: "/coding", label: "Coding sessions", icon: IconCode },
  { to: "/tools", label: "Tools", icon: IconTool },
  { to: "/settings", label: "Settings", icon: IconAdjustments },
  { to: "/audit", label: "Audit log", icon: IconHistory },
];

export function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<MeResponse>("/api/me") });
  if (me.isPending) return <Center h="100vh"><Loader /></Center>;
  if (me.isError) return <Center h="100vh"><Alert color="red" title="Admin API not reachable">{me.error.message}</Alert></Center>;
  setCsrfToken(me.data.csrfToken);
  if (!me.data.user) return <SignIn me={me.data} />;
  return <Shell me={me.data} />;
}

const SIGN_IN_ERRORS: Record<string, string> = {
  no_role: "Your account has neither the admin nor the viewer role for this app. Ask your administrator to assign one.",
  sign_in_failed: "Sign-in failed. Please try again.",
  expired: "The sign-in took too long. Please try again.",
};

function SignIn({ me }: { me: MeResponse }) {
  const qc = useQueryClient();
  const error = new URLSearchParams(window.location.search).get("error");
  const devLogin = async () => {
    await api("/auth/dev-login", { method: "POST" });
    await qc.invalidateQueries();
  };
  return (
    <Center h="100vh" p="md">
      <Paper withBorder p="xl" w={380}>
        <Stack>
          <Title order={3}>{me.botName} admin</Title>
          {error && <Alert color="red">{SIGN_IN_ERRORS[error] ?? "Sign-in failed."}</Alert>}
          {me.login.oidc && (
            <Button component="a" href="/auth/login" size="md">
              Sign in with your organization
            </Button>
          )}
          {me.login.dev && (
            <Button variant="default" onClick={devLogin}>
              Development sign-in (this machine only)
            </Button>
          )}
          {!me.login.oidc && !me.login.dev && <Text c="dimmed">No sign-in method is configured.</Text>}
        </Stack>
      </Paper>
    </Center>
  );
}

function Shell({ me }: { me: MeResponse }) {
  const [opened, { toggle, close }] = useDisclosure();
  const location = useLocation();
  const qc = useQueryClient();
  const user = me.user!;
  const signOut = async () => {
    await api("/auth/logout", { method: "POST" });
    qc.clear();
    window.location.assign("/");
  };
  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: "sm", collapsed: { mobile: !opened } }} padding="lg">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Text fw={700}>{me.botName}</Text>
            <Text c="dimmed">admin</Text>
          </Group>
          <Group gap="sm">
            <Text size="sm" visibleFrom="xs">{user.name}</Text>
            <Badge variant="light" color={user.role === "admin" ? "indigo" : "gray"}>{user.role}</Badge>
            <Button variant="subtle" size="xs" leftSection={<IconLogout size={14} />} onClick={signOut}>
              Sign out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            component={Link}
            to={n.to}
            label={n.label}
            leftSection={<n.icon size={18} stroke={1.6} />}
            active={location.pathname.startsWith(n.to)}
            onClick={close}
          />
        ))}
      </AppShell.Navbar>
      <AppShell.Main>
        <Routes>
          <Route path="/" element={<Navigate to="/channels" replace />} />
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/channels/:key" element={<ChannelDetailPage canEdit={user.role === "admin"} />} />
          <Route path="/memories" element={<MemoriesPage canEdit={user.role === "admin"} />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route path="/coding" element={<CodingPage />} />
          <Route path="/tools" element={<ToolsPage canEdit={user.role === "admin"} />} />
          <Route path="/settings" element={<SettingsPage canEdit={user.role === "admin"} />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/channels" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
