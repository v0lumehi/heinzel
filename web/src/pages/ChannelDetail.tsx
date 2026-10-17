import { Alert, Anchor, Badge, Breadcrumbs, Button, Group, NumberInput, Paper, Stack, Switch, Text, Textarea } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, type ChannelDetailResponse, type ChannelPatch, type SettingsResponse } from "../api";
import { Loaded, PageHeader, SectionTitle } from "../components";
import { channelLabel, platformLabel } from "../format";
import { AuditTable, CodingTable, MemoryTable } from "../tables";

export function ChannelDetailPage({ canEdit }: { canEdit: boolean }) {
  const key = useParams().key!;
  const detail = useQuery({ queryKey: ["channel", key], queryFn: () => api<ChannelDetailResponse>(`/api/channels/${encodeURIComponent(key)}`) });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsResponse>("/api/settings") });
  return (
    <Loaded query={detail}>
      {(d) => (
        <>
          <Breadcrumbs mb="xs">
            <Anchor component={Link} to="/channels" size="sm">Channels</Anchor>
            <Text size="sm">{channelLabel(d.channel)}</Text>
          </Breadcrumbs>
          <PageHeader title={channelLabel(d.channel)}>
            <Group gap="xs">
              <Badge variant="outline">{platformLabel(d.channel.platform)}</Badge>
              <Text size="xs" c="dimmed">{d.channel.channelKey}</Text>
            </Group>
          </PageHeader>
          <SettingsForm detail={d} defaultLimit={settings.data?.ambientDailyLimit} canEdit={canEdit} />
          <SectionTitle>Memories of this channel</SectionTitle>
          <MemoryTable rows={d.memories} canEdit={canEdit} showWhere={false} />
          <SectionTitle>Coding sessions</SectionTitle>
          <CodingTable rows={d.coding} showChannel={false} />
          <SectionTitle>Changes</SectionTitle>
          <AuditTable rows={d.audit} showTarget={false} />
        </>
      )}
    </Loaded>
  );
}

function SettingsForm({ detail, defaultLimit, canEdit }: { detail: ChannelDetailResponse; defaultLimit: number | undefined; canEdit: boolean }) {
  const c = detail.channel;
  const qc = useQueryClient();
  const [ambient, setAmbient] = useState(c.ambientEnabled);
  const [limit, setLimit] = useState<number | "">(c.dailyUnsolicitedLimit ?? "");
  const [instructions, setInstructions] = useState(c.instructions);
  useEffect(() => {
    setAmbient(c.ambientEnabled);
    setLimit(c.dailyUnsolicitedLimit ?? "");
    setInstructions(c.instructions);
  }, [c]);

  const patch: ChannelPatch = {};
  if (ambient !== c.ambientEnabled) patch.ambientEnabled = ambient;
  if ((limit === "" ? null : limit) !== c.dailyUnsolicitedLimit) patch.dailyUnsolicitedLimit = limit === "" ? null : limit;
  if (instructions !== c.instructions) patch.instructions = instructions;
  const dirty = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: () => api(`/api/channels/${encodeURIComponent(c.channelKey)}`, { method: "PATCH", body: patch }),
    onSuccess: () => {
      notifications.show({ message: "Settings saved. They apply to the next message.", color: "green" });
      void qc.invalidateQueries({ queryKey: ["channel", c.channelKey] });
      void qc.invalidateQueries({ queryKey: ["channels"] });
    },
    onError: (err) => notifications.show({ title: "Could not save", message: err.message, color: "red" }),
  });

  return (
    <Paper withBorder p="lg">
      <Stack gap="lg">
        {!canEdit && <Alert color="gray">You have read-only access.</Alert>}
        <Switch
          label="Ambient mode"
          description="Follow this channel and speak up without being tagged when the bot can clearly help."
          checked={ambient}
          onChange={(e) => setAmbient(e.currentTarget.checked)}
          disabled={!canEdit}
        />
        <NumberInput
          label="Unprompted posts per day"
          description={`Ambient replies and follow-ups. Empty = default (${defaultLimit ?? "–"}).`}
          placeholder={defaultLimit !== undefined ? `default: ${defaultLimit}` : "default"}
          min={0}
          max={1000}
          allowDecimal={false}
          value={limit}
          onChange={(v) => setLimit(typeof v === "number" ? v : "")}
          disabled={!canEdit}
          maw={260}
        />
        <Textarea
          label="Instructions for this channel"
          description="Added to the system prompt here, e.g. tone, language, team conventions. Max 4000 characters."
          autosize
          minRows={4}
          maxRows={14}
          maxLength={4000}
          value={instructions}
          onChange={(e) => setInstructions(e.currentTarget.value)}
          disabled={!canEdit}
        />
        {canEdit && (
          <Group>
            <Button onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>Save</Button>
            <Button variant="default" disabled={!dirty} onClick={() => { setAmbient(c.ambientEnabled); setLimit(c.dailyUnsolicitedLimit ?? ""); setInstructions(c.instructions); }}>
              Discard
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
