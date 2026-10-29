import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import {
  ComparisonProviders,
  StreamLinkCardComparison,
} from "./stream-link-card-comparison";
import "@/index.css";
import "./stream-link-card-comparison.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ComparisonProviders>
      <BrowserRouter>
        <StreamLinkCardComparison />
      </BrowserRouter>
    </ComparisonProviders>
  </React.StrictMode>
);
