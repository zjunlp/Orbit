// Benchmarks (design §9.16): what Orbit can evaluate — distinct benchmarks by category and domain,
// with coverage, calibration evidence, real methods and fidelity.
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
        <div className="page-pad col" style={{ gap: 16 }}>
          <BenchCatalogView />
        </div>
      </div>
    </>
  );
}
