// Six-dimensional benchmark discovery with registration-scoped evaluation evidence.
import { TopBar } from "../components/TopBar.tsx";
import { Link } from "../components/ui.tsx";
import { BenchCatalogView } from "./bench/Catalog.tsx";

export function BenchmarksPage() {
  return (
    <>
      <TopBar crumbs={[{ label: "Benchmarks" }]}>
        <Link className="btn primary sm" href="/bench/new">
          New evaluation
        </Link>
      </TopBar>
      <div className="page">
        <div className="page-pad library-page">
          <BenchCatalogView />
        </div>
      </div>
    </>
  );
}
