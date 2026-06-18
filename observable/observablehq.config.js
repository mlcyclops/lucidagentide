// Observable Framework config for the Lucid Agent IDE security dashboards.
// Data files under docs/data/*.csv are produced by `make dashboards`
// (harness/scripts/materialize_dashboards.ts -> materializeDashboards()).
export default {
  title: "Lucid Agent IDE — Security Dashboards",
  pages: [
    { name: "Operational overview", path: "/index" },
    { name: "Security", path: "/security" },
  ],
  toc: true,
};
