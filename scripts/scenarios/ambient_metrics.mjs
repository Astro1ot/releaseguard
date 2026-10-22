// Runs before the canary drills: confirms the ambient data plane and the waypoint metric labels
// the AnalysisTemplate depends on, on the actual stand rather than from documentation.
//  1. Ambient: namespace label, no sidecars in app pods, ztunnel and istio-cni ready, waypoint programmed.
//  2. Attribution: a probe HTTPRoute splits 50/50 between two backend Services of the same pods; the
//     waypoint's istio_requests_total must be attributed to each backend Service (destination_service_name),
//     otherwise stable and canary could not be told apart.
//  3. Both entry points (in-mesh client and ingress gateway) reach the waypoint and the same route.
//  4. The label names and the stable-side analysis queries return data.
import { args, check, evaluateProbeSplit, kjson, kubectl, now, promSeries, promVector, scenario, sleep, waitFor } from './lib.mjs';

const opts = args();
const ns = opts.namespace ?? 'rg-canary';
const release = opts.release ?? 'releaseguard';
const port = 3000;

const probe = (name, backends) => [
  ...['', ...backends].map(suffix => ({
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: `${name}${suffix}`, labels: suffix ? {} : { 'istio.io/use-waypoint': `${release}-waypoint` } },
    spec: { selector: { app: release }, ports: [{ name: 'http', port, targetPort: 'http' }] },
  })),
  { apiVersion: 'gateway.networking.k8s.io/v1', kind: 'HTTPRoute', metadata: { name },
    spec: { parentRefs: [{ group: '', kind: 'Service', name, port }], rules: [{ backendRefs: backends.map(s => ({ name: `${name}${s}`, port, weight: 50 })) }] } },
];

await scenario('ambient-metrics', { probeSplitPercent: '25..75 per backend', probeRequests: 400 }, async report => {
  // 1. Ambient data plane
  const nsLabels = kjson(null, ['get', 'namespace', ns]).metadata.labels ?? {};
  check(report, 'namespace enrolled in ambient', 'istio.io/dataplane-mode=ambient', nsLabels['istio.io/dataplane-mode'], nsLabels['istio.io/dataplane-mode'] === 'ambient');
  const pods = kjson(ns, ['get', 'pods', '-l', `app=${release}`]).items;
  const containers = [...new Set(pods.flatMap(p => [...(p.spec.initContainers ?? []), ...p.spec.containers].map(c => c.name)))];
  check(report, 'application pods have no sidecar', 'no istio-proxy / istio-init', containers, pods.length > 0 && !containers.some(c => c.startsWith('istio-')));
  for (const ds of ['ztunnel', 'istio-cni-node']) {
    const st = kjson('istio-system', ['get', 'daemonset', ds]).status;
    check(report, `${ds} ready on every node`, `${st.desiredNumberScheduled} ready`, st.numberReady, st.numberReady > 0 && st.numberReady === st.desiredNumberScheduled);
  }
  const waypoint = kjson(ns, ['get', 'gateways.gateway.networking.k8s.io', `${release}-waypoint`]);
  const programmed = waypoint.status?.conditions?.find(c => c.type === 'Programmed')?.status;
  check(report, 'waypoint Gateway programmed', 'True', programmed, programmed === 'True');
  const route = kjson(ns, ['get', 'httproutes.gateway.networking.k8s.io', release]);
  const accepted = route.status?.parents?.map(p => p.conditions?.find(c => c.type === 'Accepted')?.status) ?? [];
  check(report, 'canary HTTPRoute accepted for the Service parent', 'Accepted=True', accepted, accepted.includes('True'));
  report.evidence.httpRouteStatus = route.status;

  // 2. Backend attribution through a probe split
  const name = 'rg-probe';
  const objects = probe(name, ['-a', '-b']);
  kubectl(ns, ['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }) });
  try {
    await waitFor('probe HTTPRoute accepted', () => kjson(ns, ['get', 'httproutes.gateway.networking.k8s.io', name]).status?.parents?.some(p => p.conditions?.some(c => c.type === 'Accepted' && c.status === 'True')), { timeoutMs: 120_000, intervalMs: 3000 });
    await sleep(5000);
    const script = `let ok=0,fail=0;const one=async()=>{try{const r=await fetch('http://${name}:${port}/api/catalog');await r.arrayBuffer();r.ok?ok++:fail++}catch{fail++}};(async()=>{for(let i=0;i<400;i+=10)await Promise.all(Array.from({length:10},one));console.log(JSON.stringify({ok,fail}))})()`;
    report.measured.probeClient = JSON.parse(kubectl(ns, ['exec', 'deploy/releaseguard-loadgen', '-c', 'loadgen', '--', 'node', '-e', script]).stdout.trim());
    report.timeline.push({ at: now(), event: 'probe traffic sent', ...report.measured.probeClient });
    await sleep(20_000); // two scrape intervals plus waypoint flush
    const rows = promVector(`sum by (destination_service_name) (increase(istio_requests_total{reporter="waypoint",destination_service_namespace="${ns}",destination_service_name=~"${name}.*"}[3m]))`);
    const split = evaluateProbeSplit(rows, name, [`${name}-a`, `${name}-b`]);
    report.measured.probeSplit = split;
    check(report, 'waypoint metrics attribute requests to each backend Service (stable/canary separable)', `${name}-a and ${name}-b each 25–75 %`, split.shares, split.attributedToBackends);
    report.measured.probeParentSeenAsDestination = split.parentSeen;
    report.evidence.waypointSeriesLabels = promSeries(`istio_requests_total{reporter="waypoint",destination_service_namespace="${ns}",destination_service_name=~"${name}.*"}`).slice(0, 5);
  } finally {
    kubectl(ns, ['delete', 'httproutes.gateway.networking.k8s.io', name, '--ignore-not-found']);
    kubectl(ns, ['delete', 'service', name, `${name}-a`, `${name}-b`, '--ignore-not-found']);
  }

  // 3. Both entry points pass the same waypoint and route
  const sources = promVector(`sum by (source_workload, destination_service_name) (increase(istio_requests_total{reporter="waypoint",destination_service_namespace="${ns}",destination_service_name="${release}-stable"}[2m]))`);
  report.measured.waypointSources = sources.map(s => ({ source: s.labels.source_workload, destination: s.labels.destination_service_name, requests: Math.round(s.value) }));
  const sourceNames = sources.filter(s => s.value > 0).map(s => s.labels.source_workload);
  check(report, 'in-mesh entry reaches the waypoint', 'source_workload releaseguard-loadgen', sourceNames, sourceNames.includes('releaseguard-loadgen'));
  check(report, 'ingress-gateway entry reaches the same waypoint', `source_workload ${release}-ingress-istio`, sourceNames, sourceNames.includes(`${release}-ingress-istio`));

  // 4. Labels and queries used by the AnalysisTemplate
  const series = promSeries(`istio_requests_total{reporter="waypoint",destination_service_name="${release}-stable"}`);
  const labelNames = [...new Set(series.flatMap(s => Object.keys(s)))].sort();
  report.measured.waypointLabelNames = labelNames;
  const needed = ['reporter', 'destination_service_namespace', 'destination_service_name', 'response_code', 'source_workload'];
  check(report, 'labels used by the analysis exist on waypoint series', needed.join(', '), needed.filter(l => !labelNames.includes(l)), needed.every(l => labelNames.includes(l)));
  const buckets = promVector(`count(istio_request_duration_milliseconds_bucket{reporter="waypoint",destination_service_name="${release}-stable"})`);
  check(report, 'waypoint latency histogram present', 'istio_request_duration_milliseconds_bucket > 0 series', buckets[0]?.value ?? 0, (buckets[0]?.value ?? 0) > 0);
  const p95 = promVector(`histogram_quantile(0.95, sum by (le) (rate(istio_request_duration_milliseconds_bucket{reporter="waypoint",destination_service_namespace="${ns}",destination_service_name="${release}-stable"}[1m])))`);
  report.measured.stableP95Ms = p95[0]?.value ?? null;
  check(report, 'stable-side latency query returns a value', 'number', report.measured.stableP95Ms, Number.isFinite(report.measured.stableP95Ms));
});
