import { useQuery } from "@tanstack/react-query";
import { api, type CodingRow } from "../api";
import { Loaded, PageHeader } from "../components";
import { CodingTable } from "../tables";

export function CodingPage() {
  const sessions = useQuery({ queryKey: ["coding"], queryFn: () => api<CodingRow[]>("/api/coding"), refetchInterval: 15_000 });
  return (
    <>
      <PageHeader title="Coding sessions" />
      <Loaded query={sessions}>{(rows) => <CodingTable rows={rows} />}</Loaded>
    </>
  );
}
