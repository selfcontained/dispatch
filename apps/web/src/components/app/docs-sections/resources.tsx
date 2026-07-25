import { H3, P, Section } from "./primitives";

export function ResourcesContent(): JSX.Element {
  return (
    <>
      <Section>
        <H3>Service resources dashboard</H3>
        <P>
          <strong>Settings → Resources</strong> shows live health and resource
          insights for the Dispatch server, its agent processes, dependencies,
          and the host machine. An overall status badge sits next to the title;
          when something is off, a <strong>Dispatch needs attention</strong>{" "}
          card at the top explains why.
        </P>
      </Section>

      <Section>
        <H3>Enabling collection</H3>
        <P>
          Metrics collection is <strong>off by default</strong>. Turn on{" "}
          <strong>Collect resource metrics</strong> to sample service health and
          resource usage every 5 seconds, keeping up to one hour of history in
          memory. Turning collection off clears the collected history, and
          history also resets when Dispatch restarts — nothing is written to the
          database. Both directions ask for confirmation. A window picker
          switches the charts between the last 15 minutes and the last hour.
        </P>
      </Section>

      <Section>
        <H3>What's shown</H3>
        <P>
          Summary cards cover Dispatch's CPU (one-core percentage) and memory
          (resident set plus JS heap), the agent process tree's combined CPU and
          memory, database latency and connection-pool usage, event-loop and API
          p95 latencies, and the host's free memory and load. Below them, CPU
          and memory history charts plot Dispatch, agents, and host load over
          the selected window.
        </P>
        <P>
          A workload card counts running agents, connected browsers, active
          terminal views, scheduled jobs, and in-flight git refreshes; a
          capacity card lists service uptime, database pool size, requests per
          minute, and host CPU count.
        </P>
      </Section>

      <Section>
        <H3>Subsystem health</H3>
        <P>
          Each background subsystem — the API server, database, job schedulers,
          UI event stream, terminal observers, agent reconciliation, activity
          monitor, git diff refreshes, and the update checker — reports its own
          status badge with run counts, failure rates, p95 durations, and a
          recent-trend sparkline, so you can spot which part of Dispatch is
          struggling rather than just that something is.
        </P>
      </Section>
    </>
  );
}
