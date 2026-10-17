import { Alert, Badge, Button, Group, NumberInput, Paper, Stack, Switch, Text, TextInput, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconLock } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { api, type ConfigResponse, type ConfigSettingRow } from "../api";
import { Loaded, PageHeader, SectionTitle } from "../components";

const SOURCE = {
  admin: { label: "changed here", color: "indigo" },
  deployment: { label: "deployment", color: "gray" },
  default: { label: "default", color: "gray" },
} as const;

export function SettingsPage({ canEdit }: { canEdit: boolean }) {
  const config = useQuery({ queryKey: ["config"], queryFn: () => api<ConfigResponse>("/api/config") });
  const { hash } = useLocation();
  // Jump to a group (e.g. #data from the setup page) once the settings are loaded.
  useEffect(() => {
    if (hash && config.data) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth" });
  }, [hash, config.data]);
  return (
    <>
      <PageHeader title="Settings" />
      <Text c="dimmed" mb="md" maw={760}>
        Changes apply immediately on all instances. The values from the deployment (environment, Helm values) are the starting point. A value
        changed here replaces them until you reset it. Settings listed in LOCKED_SETTINGS can only be changed in the deployment.
      </Text>
      <Loaded query={config}>
        {(c) => {
          const groups = [...new Set(c.settings.map((s) => s.group))];
          return groups.map((g) => (
            <div key={g} id={g.toLowerCase().replace(/\s+/g, "-")} style={{ scrollMarginTop: 72 }}>
              <SectionTitle>{g}</SectionTitle>
              <Paper withBorder>
                {c.settings
                  .filter((s) => s.group === g)
                  .map((s, i) => (
                    <SettingRow key={s.key} setting={s} canEdit={canEdit} first={i === 0} />
                  ))}
              </Paper>
            </div>
          ));
        }}
      </Loaded>
    </>
  );
}

function SettingRow({ setting: s, canEdit, first }: { setting: ConfigSettingRow; canEdit: boolean; first: boolean }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(s.value);
  useEffect(() => setValue(s.value), [s.value]);
  const editable = canEdit && !s.locked;

  const save = useMutation({
    mutationFn: (v: string | null) => api(`/api/config/${s.key}`, { method: "PUT", body: { value: v } }),
    onSuccess: (_d, v) => {
      notifications.show({ message: v === null ? `${s.label}: back to the deployment value` : `${s.label} saved`, color: "green" });
      void qc.invalidateQueries({ queryKey: ["config"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => {
      notifications.show({ title: "Not saved", message: err.message, color: "red" });
      setValue(s.value);
    },
  });

  const input =
    s.kind === "boolean" ? (
      <Switch checked={value === "true"} disabled={!editable || save.isPending} onChange={(e) => save.mutate(String(e.currentTarget.checked))} />
    ) : s.kind === "number" ? (
      <NumberInput value={value === "" ? "" : Number(value)} onChange={(v) => setValue(v === "" ? "" : String(v))} disabled={!editable} w={160} decimalScale={2} />
    ) : (
      <TextInput value={value} onChange={(e) => setValue(e.currentTarget.value)} disabled={!editable} w={{ base: "100%", sm: 360 }} ff="monospace" />
    );

  return (
    <Group justify="space-between" align="flex-start" p="md" wrap="wrap" gap="sm" style={first ? undefined : { borderTop: "1px solid var(--mantine-color-default-border)" }}>
      <Stack gap={2} maw={420}>
        <Group gap={6}>
          <Text fw={500}>{s.label}</Text>
          <Badge size="xs" variant="light" color={SOURCE[s.source].color}>{SOURCE[s.source].label}</Badge>
          {s.locked && (
            <Tooltip label="Locked by the deployment (LOCKED_SETTINGS)">
              <IconLock size={14} />
            </Tooltip>
          )}
        </Group>
        {s.help && <Text size="xs" c="dimmed">{s.help}</Text>}
        <Text size="xs" c="dimmed" ff="monospace">
          {s.key}
          {s.source === "admin" && ` · deployment: ${s.deploymentValue || "(empty)"}`}
        </Text>
      </Stack>
      <Group gap="xs" align="center">
        {input}
        {editable && s.kind !== "boolean" && value !== s.value && (
          <Button size="xs" onClick={() => save.mutate(value)} loading={save.isPending}>Save</Button>
        )}
        {editable && s.source === "admin" && (
          <Button size="xs" variant="subtle" onClick={() => save.mutate(null)} disabled={save.isPending}>Reset</Button>
        )}
      </Group>
    </Group>
  );
}

export function SecretsKeyHint({ canStoreSecrets }: { canStoreSecrets: boolean }) {
  if (canStoreSecrets) return null;
  return (
    <Alert color="yellow" mb="md">
      SECRETS_KEY is not set, so servers that need a token (headers) cannot be stored. Generate one with <code>openssl rand -base64 32</code> and add
      it to the deployment's secrets.
    </Alert>
  );
}
