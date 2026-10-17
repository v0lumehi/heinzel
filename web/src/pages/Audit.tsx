import { useQuery } from "@tanstack/react-query";
import { api, type AuditRow } from "../api";
import { Loaded, PageHeader } from "../components";
import { AuditTable } from "../tables";

export function AuditPage() {
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => api<AuditRow[]>("/api/audit") });
  return (
    <>
      <PageHeader title="Audit log" />
      <Loaded query={audit}>{(rows) => <AuditTable rows={rows} />}</Loaded>
    </>
  );
}
