import { Anchor, Badge, Button, Code, Group, Paper, Table, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type AuditRow, type CodingRow, type MemoryRow } from "./api";
import { EmptyRow } from "./components";
import { fmtDate } from "./format";

const SCOPE_COLOR = { channel: "indigo", org: "teal", user: "orange" } as const;

function memoryWhere(m: MemoryRow): string {
  if (m.scope === "org") return "whole organization";
  if (m.scope === "channel") return m.channelName ?? m.scopeKey;
  return m.scopeKey;
}

export function MemoryTable({ rows, canEdit, showWhere = true }: { rows: MemoryRow[]; canEdit: boolean; showWhere?: boolean }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<number | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/memories/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      notifications.show({ message: "Memory deleted", color: "green" });
      void qc.invalidateQueries({ queryKey: ["memories"] });
      void qc.invalidateQueries({ queryKey: ["channel"] });
    },
    onError: (err) => notifications.show({ title: "Could not delete", message: err.message, color: "red" }),
    onSettled: () => setConfirming(null),
  });
  const cols = showWhere ? 5 : 4;
  return (
    <Paper withBorder>
      <Table.ScrollContainer minWidth={700}>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Memory</Table.Th>
              {showWhere && <Table.Th>Applies to</Table.Th>}
              <Table.Th>Saved by</Table.Th>
              <Table.Th>Saved</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.length === 0 && <EmptyRow cols={cols} text="No memories." />}
            {rows.map((m) => (
              <Table.Tr key={m.id}>
                <Table.Td maw={520}>{m.content}</Table.Td>
                {showWhere && (
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Badge variant="light" color={SCOPE_COLOR[m.scope]}>{m.scope}</Badge>
                      <Text size="sm">{memoryWhere(m)}</Text>
                    </Group>
                  </Table.Td>
                )}
                <Table.Td><Text size="sm" c="dimmed">{m.createdBy}</Text></Table.Td>
                <Table.Td><Text size="sm">{fmtDate(m.createdAt)}</Text></Table.Td>
                <Table.Td ta="right">
                  {canEdit &&
                    (confirming === m.id ? (
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Button size="compact-xs" color="red" loading={remove.isPending} onClick={() => remove.mutate(m.id)}>Delete</Button>
                        <Button size="compact-xs" variant="default" onClick={() => setConfirming(null)}>Cancel</Button>
                      </Group>
                    ) : (
                      <Button size="compact-xs" variant="subtle" color="red" onClick={() => setConfirming(m.id)}>Delete…</Button>
                    ))}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}

const STATUS_COLOR: Record<string, string> = {
  succeeded: "green", no_changes: "gray", failed: "red", cancelled: "gray", timed_out: "red", expired: "gray",
  awaiting_confirmation: "yellow", queued: "blue", running: "blue", cancelling: "orange",
};

export function CodingTable({ rows, showChannel = true }: { rows: CodingRow[]; showChannel?: boolean }) {
  return (
    <Paper withBorder>
      <Table.ScrollContainer minWidth={700}>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>#</Table.Th>
              <Table.Th>Task</Table.Th>
              <Table.Th>Repository</Table.Th>
              {showChannel && <Table.Th>Channel</Table.Th>}
              <Table.Th>Status</Table.Th>
              <Table.Th>Requested</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.length === 0 && <EmptyRow cols={showChannel ? 6 : 5} text="No coding sessions." />}
            {rows.map((s) => (
              <Table.Tr key={s.id}>
                <Table.Td>{s.id}</Table.Td>
                <Table.Td maw={380}>
                  <Text size="sm" fw={500}>{s.title}</Text>
                  {s.mergeRequestUrl && <Anchor size="xs" href={s.mergeRequestUrl} target="_blank" rel="noreferrer">merge request</Anchor>}
                  {s.error && <Text size="xs" c="red">{s.error}</Text>}
                </Table.Td>
                <Table.Td><Code>{s.repository}</Code></Table.Td>
                {showChannel && <Table.Td><Text size="sm">{s.channelKey}</Text></Table.Td>}
                <Table.Td><Badge variant="light" color={STATUS_COLOR[s.status] ?? "gray"}>{s.status.replace(/_/g, " ")}</Badge></Table.Td>
                <Table.Td>
                  <Text size="sm">{fmtDate(s.createdAt)}</Text>
                  {s.requestedByName && <Text size="xs" c="dimmed">{s.requestedByName}</Text>}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}

function describeAudit(a: AuditRow): string {
  const d = a.details as Record<string, unknown>;
  if (a.action === "channel.update" && d.command) return `chat command ${JSON.stringify(d.command)}`;
  if (a.action === "channel.update") {
    return Object.entries(d)
      .map(([k, v]) => {
        const c = v as { from: unknown; to: unknown };
        return `${k}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`;
      })
      .join(", ");
  }
  if (a.action === "memory.delete") return `“${String(d.content ?? "")}”`;
  return Object.keys(d).length ? JSON.stringify(d) : "";
}

export function AuditTable({ rows, showTarget = true }: { rows: AuditRow[]; showTarget?: boolean }) {
  return (
    <Paper withBorder>
      <Table.ScrollContainer minWidth={700}>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>When</Table.Th>
              <Table.Th>Who</Table.Th>
              <Table.Th>Action</Table.Th>
              {showTarget && <Table.Th>Target</Table.Th>}
              <Table.Th>Details</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.length === 0 && <EmptyRow cols={showTarget ? 5 : 4} text="Nothing recorded yet." />}
            {rows.map((a) => (
              <Table.Tr key={a.id}>
                <Table.Td><Text size="sm">{fmtDate(a.createdAt)}</Text></Table.Td>
                <Table.Td>
                  <Text size="sm">{a.actorName ?? a.actor}</Text>
                  <Text size="xs" c="dimmed">{a.actor}</Text>
                </Table.Td>
                <Table.Td><Code>{a.action}</Code></Table.Td>
                {showTarget && <Table.Td><Text size="sm">{a.target ?? "–"}</Text></Table.Td>}
                <Table.Td maw={420}><Text size="sm">{describeAudit(a)}</Text></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}
