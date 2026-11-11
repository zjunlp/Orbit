// Product integrations are the default; local setup and evidence stay in a separate view.
import { TopBar } from "../components/TopBar.tsx";
import { Link } from "../components/ui.tsx";
import { useLocation } from "../lib/router.ts";
import { BenchmarkLibrary } from "./bench/BenchmarkLibrary.tsx";
import { BenchCatalogView } from "./bench/Catalog.tsx";

export function BenchmarksPage() {
  const { query } = useLocation();
  const local = query.get("mode") === "local" || query.has("ev");
  return (
    <>
      <TopBar crumbs={[{ label: "Benchmarks" }]}>
        <Link className="btn sm" href={local ? "/benchmarks" : "/benchmarks?mode=local"}>
          {local ? "All benchmarks" : "Local setups"}
        </Link>
        <Link className="btn primary sm" href="/bench/new">
          New evaluation
        </Link>
      </TopBar>
      <div className="page">
        <div className="page-pad library-page">
          {local ? <BenchCatalogView /> : <BenchmarkLibrary />}
        </div>
      </div>
    </>
  );
}
