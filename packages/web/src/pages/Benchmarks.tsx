// Product integrations are the default; local setup and evidence stay in a separate view.
import { TopBar } from "../components/TopBar.tsx";
import { Link } from "../components/ui.tsx";
import { useLocation } from "../lib/router.ts";
import { BenchmarkLibrary } from "./bench/BenchmarkLibrary.tsx";
import { BenchCatalogView } from "./bench/Catalog.tsx";
import { OnboardingView } from "./bench/Onboarding.tsx";
import { PreparationView } from "./bench/Preparation.tsx";

export function BenchmarksPage() {
  const { query } = useLocation();
  const local = query.get("mode") === "local" || query.has("ev");
  const adding = query.get("mode") === "add";
  const preparing = query.get("mode") === "resources";
  return (
    <>
      <TopBar crumbs={[{ label: "Benchmarks" }]}>
        <Link className="btn sm" href={adding ? "/benchmarks" : "/benchmarks?mode=add"}>
          {adding ? "Back to library" : "Add your own benchmark"}
        </Link>
        <Link className="btn sm" href="/benchmarks?mode=resources">
          Prepare resources
        </Link>
        <Link className="btn sm" href={local ? "/benchmarks" : "/benchmarks?mode=local"}>
          {local ? "All benchmarks" : "Local setups"}
        </Link>
        <Link className="btn primary sm" href="/bench/new">
          New evaluation
        </Link>
      </TopBar>
      <div className="page">
        <div className="page-pad library-page">
          {adding ? (
            <OnboardingView />
          ) : preparing ? (
            <PreparationView />
          ) : local ? (
            <BenchCatalogView />
          ) : (
            <BenchmarkLibrary />
          )}
        </div>
      </div>
    </>
  );
}
