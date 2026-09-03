import { useMemo, useState } from 'react';

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('en-IN').format(number) : '-';
}

function formatMoney(value, currency = 'USD') {
  if (value === null || value === undefined || value === '') return 'Unavailable';
  const number = Number(value);
  if (!Number.isFinite(number)) return 'Unavailable';
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: currency === 'INR' ? 2 : 4 }).format(number);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return 'Unavailable';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${unit}`;
}

function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return '-';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} sec`;
  const minutes = milliseconds / 60_000;
  if (minutes < 60) return `${minutes.toFixed(1)} min`;
  return `${(minutes / 60).toFixed(1)} hr`;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function humanize(value = '') {
  return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function metricValue(metric, currency = 'USD') {
  if (metric.value === null || metric.value === undefined) return 'Unavailable';
  if (metric.format === 'bytes') return formatBytes(metric.value);
  if (metric.format === 'duration') return formatDuration(metric.value);
  if (metric.format === 'percent') return `${Number(metric.value).toFixed(1)}%`;
  if (metric.format === 'money') return formatMoney(metric.value, currency);
  return formatNumber(metric.value);
}

function DataState({ state, empty = 'No information is available yet.' }) {
  if (state?.loading) return <div className="management-state">Loading current data...</div>;
  if (state?.error) return <div className="management-state error">{state.error}</div>;
  if (!state?.data) return <div className="management-state">{empty}</div>;
  return null;
}

function StatusBadge({ status }) {
  const normalized = String(status || 'unknown').toLowerCase();
  return <span className={`management-status ${normalized}`}>{humanize(normalized)}</span>;
}

function SourceBadge({ source }) {
  return <span className={`cost-source ${source || 'unavailable'}`}>{humanize(source || 'unavailable')}</span>;
}

function MetricStrip({ items = [], currency = 'USD' }) {
  return (
    <section className="management-metrics" aria-label="Summary metrics">
      {items.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>
          <strong>{item.format ? metricValue(item, currency) : item.value}</strong>
          {item.meta && <small>{item.meta}</small>}
        </div>
      ))}
    </section>
  );
}

function SystemOverviewPage({ state, onNavigate }) {
  const data = state.data;
  if (!data) return <DataState state={state} />;
  const services = data.services || [];
  const healthy = services.filter((service) => ['healthy', 'configured'].includes(service.status)).length;
  const requests = data.metrics?.requestHistory?.endpoints || data.metrics?.requests || [];
  const requestTotal = requests.reduce((total, item) => total + Number(item.requests || 0), 0);
  const errors = requests.reduce((total, item) => total + Number(item.errors || 0), 0);
  const memory = data.metrics?.system?.memory || {};

  return (
    <div className="management-page">
      <section className={`management-overview-band ${data.overall === 'healthy' ? 'healthy' : 'degraded'}`}>
        <div><span>Current status</span><h2>{data.overall === 'healthy' ? 'All required services are responding' : 'One or more services need attention'}</h2><p>Last checked {formatDate(data.generatedAt)}</p></div>
        <StatusBadge status={data.overall} />
      </section>
      <MetricStrip items={[
        { label: 'Services ready', value: `${healthy} / ${services.length}` },
        { label: 'Open incidents', value: formatNumber(data.activeIncidents?.length || 0) },
        { label: 'Requests in 24h window', value: formatNumber(requestTotal) },
        { label: 'API error rate', value: requestTotal ? `${((errors / requestTotal) * 100).toFixed(2)}%` : '0%' },
        { label: 'Generation success 24h', value: `${Number(data.generation24h?.successRate || 0).toFixed(1)}%` }
      ]} />
      <div className="management-two-column">
        <section className="admin-card management-panel">
          <div className="section-head"><div><h2>Service pulse</h2><p>Core services and configured providers.</p></div><button type="button" onClick={() => onNavigate('service-health')}>View all</button></div>
          <div className="management-list">
            {services.slice(0, 7).map((service) => <div key={service.id}><span className={`service-dot ${service.status}`} /><div><strong>{service.label}</strong><small>{service.detail}</small></div><StatusBadge status={service.status} /></div>)}
          </div>
        </section>
        <section className="admin-card management-panel">
          <div className="section-head"><div><h2>Runtime</h2><p>Current API host resource usage.</p></div><button type="button" onClick={() => onNavigate('api-performance')}>Performance</button></div>
          <dl className="management-definition-list">
            <div><dt>Instance</dt><dd>{data.metrics?.system?.instanceId || data.metrics?.system?.hostname || '-'}</dd></div>
            <div><dt>Process uptime</dt><dd>{formatDuration(Number(data.metrics?.system?.process?.uptimeSeconds || 0) * 1000)}</dd></div>
            <div><dt>CPU cores</dt><dd>{formatNumber(data.metrics?.system?.cpuCount || 0)}</dd></div>
            <div><dt>Process memory</dt><dd>{formatBytes(memory.processRss || 0)}</dd></div>
            <div><dt>Free host memory</dt><dd>{formatBytes(memory.free || 0)}</dd></div>
            <div><dt>Node</dt><dd>{data.metrics?.system?.process?.node || '-'}</dd></div>
          </dl>
        </section>
      </div>
      <section className="admin-card management-panel">
        <div className="section-head"><div><h2>Active incidents</h2><p>Failures that have not been resolved.</p></div><button type="button" onClick={() => onNavigate('failures')}>Open failures</button></div>
        {(data.activeIncidents || []).length === 0 ? <div className="management-empty">No active incidents.</div> : <div className="incident-list compact">{data.activeIncidents.slice(0, 6).map((incident) => <article key={incident.id}><div><strong>{incident.title}</strong><span>{incident.service} · {formatDate(incident.lastSeenAt)}</span></div><StatusBadge status={incident.severity} /></article>)}</div>}
      </section>
    </div>
  );
}

function ServiceHealthPage({ state }) {
  const data = state.data;
  if (!data) return <DataState state={state} />;
  const groups = [
    ['core', 'Core infrastructure'],
    ['provider', 'External providers']
  ];
  return (
    <div className="management-page">
      {groups.map(([group, label]) => (
        <section className="admin-card management-panel" key={group}>
          <div className="section-head"><div><h2>{label}</h2><p>Status from the API host. Billing connectivity is tracked separately.</p></div><span className="last-checked">Checked {formatDate(data.generatedAt)}</span></div>
          <div className="service-health-table">
            {(data.services || []).filter((service) => service.group === group).map((service) => (
              <div key={service.id}><span className={`service-dot ${service.status}`} /><div><strong>{service.label}</strong><small>{service.detail}</small></div><span>{formatDate(service.checkedAt)}</span><StatusBadge status={service.status} /></div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function FailuresPage({ incidentsState, generationState, onIncidentStatus }) {
  const [status, setStatus] = useState('active');
  const incidents = incidentsState.data?.items || [];
  const filtered = status === 'all' ? incidents : incidents.filter((incident) => status === 'active' ? incident.status !== 'resolved' : incident.status === status);
  return (
    <div className="management-page">
      <section className="admin-card management-panel">
        <div className="section-head"><div><h2>System incidents</h2><p>Persistent backend failures and failed health checks.</p></div><label className="compact-field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">Active</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option><option value="all">All</option></select></label></div>
        <DataState state={incidentsState} />
        {!incidentsState.loading && !incidentsState.error && filtered.length === 0 && <div className="management-empty">No incidents match this status.</div>}
        <div className="incident-list">
          {filtered.map((incident) => (
            <article key={incident.id}>
              <span className={`incident-severity ${incident.severity}`} />
              <div><strong>{incident.title}</strong><p>{incident.message || 'No additional detail recorded.'}</p><span>{humanize(incident.service)} · {formatNumber(incident.occurrences)} occurrence{incident.occurrences === 1 ? '' : 's'} · Last {formatDate(incident.lastSeenAt)}</span></div>
              <StatusBadge status={incident.status} />
              <div className="incident-actions">
                {incident.status === 'open' && <button type="button" onClick={() => onIncidentStatus(incident.id, 'acknowledged')}>Acknowledge</button>}
                {incident.status !== 'resolved' && <button type="button" onClick={() => onIncidentStatus(incident.id, 'resolved')}>Resolve</button>}
                {incident.status === 'resolved' && <button type="button" onClick={() => onIncidentStatus(incident.id, 'open')}>Reopen</button>}
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="admin-card management-panel">
        <div className="section-head"><div><h2>Recent generation failures</h2><p>Provider and validation failures recorded by the AI pipeline.</p></div></div>
        <DataState state={generationState} />
        <div className="management-table-wrap"><table className="management-table"><thead><tr><th>Time</th><th>Provider</th><th>Type</th><th>Category</th><th>Duration</th><th>Credits restored</th></tr></thead><tbody>{(generationState.data?.recentFailures || []).map((failure) => <tr key={failure.id}><td>{formatDate(failure.createdAt)}</td><td>{failure.provider || '-'}</td><td>{humanize(failure.type)}</td><td><StatusBadge status={failure.errorCategory} /></td><td>{formatDuration(failure.durationMs)}</td><td>{formatNumber(failure.tokensRefunded)}</td></tr>)}</tbody></table></div>
      </section>
    </div>
  );
}

function ApiPerformancePage({ state }) {
  const data = state.data;
  if (!data) return <DataState state={state} />;
  const history = data.metrics?.requestHistory;
  const endpoints = [...(history?.endpoints || data.metrics?.requests || [])].sort((left, right) => Number(right.p95Ms || 0) - Number(left.p95Ms || 0));
  const totalRequests = endpoints.reduce((total, item) => total + Number(item.requests || 0), 0);
  const totalErrors = endpoints.reduce((total, item) => total + Number(item.errors || 0), 0);
  return (
    <div className="management-page">
      <MetricStrip items={[
        { label: 'Requests', value: formatNumber(totalRequests) },
        { label: 'Server errors', value: formatNumber(totalErrors) },
        { label: 'Error rate', value: totalRequests ? `${((totalErrors / totalRequests) * 100).toFixed(2)}%` : '0%' },
        { label: 'Tracked endpoints', value: formatNumber(endpoints.length) },
        { label: 'API instances', value: history ? formatNumber(history.instances?.length || 0) : 'Current only' },
        { label: 'Active Nginx connections', value: data.metrics?.nginx?.ok ? formatNumber(data.metrics.nginx.active || 0) : 'Not connected' }
      ]} />
      <section className="admin-card management-panel">
        <div className="section-head"><div><h2>Endpoint performance</h2><p>{history ? `Persistent ${history.hours}-hour metrics aggregated across API instances.` : 'Current-process metrics; persistent history is not enabled.'}</p></div><span className="last-checked">Generated {formatDate(data.generatedAt)}</span></div>
        {endpoints.length === 0 ? <div className="management-empty">No endpoint traffic has been recorded on this process yet.</div> : <div className="management-table-wrap"><table className="management-table"><thead><tr><th>Endpoint</th><th>Requests</th><th>Errors</th><th>Average</th><th>P50</th><th>P95</th><th>P99</th><th>Maximum</th></tr></thead><tbody>{endpoints.map((item) => <tr key={item.endpoint}><td><strong>{item.endpoint}</strong></td><td>{formatNumber(item.requests)}</td><td>{formatNumber(item.errors)}</td><td>{formatDuration(item.avgMs)}</td><td>{formatDuration(item.p50Ms)}</td><td>{formatDuration(item.p95Ms)}</td><td>{formatDuration(item.p99Ms)}</td><td>{formatDuration(item.maxMs)}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
  );
}

function GenerationPipelinePage({ state }) {
  const data = state.data;
  if (!data) return <DataState state={state} />;
  const totals = data.totals || {};
  return (
    <div className="management-page">
      <MetricStrip currency="USD" items={[
        { label: 'Attempts', value: formatNumber(totals.attempted || 0) },
        { label: 'Success rate', value: `${Number(totals.successRate || 0).toFixed(1)}%` },
        { label: 'Average duration', value: formatDuration(totals.averageDurationMs || 0) },
        { label: 'Credits charged', value: formatNumber(totals.tokensCharged || 0) },
        { label: 'Credits restored', value: formatNumber(totals.tokensRefunded || 0) },
        { label: 'Tracked estimate', value: formatMoney(totals.providerCostUsd || 0, 'USD') }
      ]} />
      <div className="management-two-column">
        <section className="admin-card management-panel"><div className="section-head"><div><h2>Providers</h2><p>Reliability and latency by provider.</p></div></div><div className="management-table-wrap"><table className="management-table"><thead><tr><th>Provider</th><th>Requests</th><th>Success</th><th>Average</th><th>Cost</th></tr></thead><tbody>{(data.providers || []).map((item) => <tr key={item.provider}><td><strong>{item.provider}</strong></td><td>{formatNumber(item.total)}</td><td>{Number(item.successRate || 0).toFixed(1)}%</td><td>{formatDuration(item.averageDurationMs)}</td><td>{formatMoney(item.costUsd || 0, 'USD')}</td></tr>)}</tbody></table></div></section>
        <section className="admin-card management-panel"><div className="section-head"><div><h2>Failure categories</h2><p>Most common recorded causes.</p></div></div><div className="management-ranked-list">{(data.errors || []).map((item) => <div key={item.category}><span>{humanize(item.category)}</span><strong>{formatNumber(item.count)}</strong></div>)}{(data.errors || []).length === 0 && <div className="management-empty">No failures in this period.</div>}</div></section>
      </div>
      <section className="admin-card management-panel"><div className="section-head"><div><h2>Daily generation activity</h2><p>Successful and failed attempts across the selected period.</p></div></div><div className="daily-bars">{(data.daily || []).map((day) => { const total = Math.max(Number(day.total || 0), 1); return <div key={day.date}><span>{day.date.slice(5)}</span><div title={`${day.succeeded} succeeded, ${day.failed} failed`}><i style={{ height: `${Math.max(4, (Number(day.succeeded || 0) / total) * 100)}%` }} /><b style={{ height: `${(Number(day.failed || 0) / total) * 100}%` }} /></div><small>{formatNumber(day.total)}</small></div>; })}</div></section>
    </div>
  );
}

function MobileReportPage({ state, platform }) {
  const data = state.data;
  if (!data) return <DataState state={state} />;
  const web = data.webTelemetry || {};
  return (
    <div className="management-page">
      <section className="integration-notice">
        <div><strong>Native {platform === 'ios' ? 'iOS' : 'Android'} reporting is not connected</strong><p>The figures below are mobile browser sessions. Crash, release, store, and device reports will remain unavailable until a native reporting source is connected.</p></div>
        <StatusBadge status="not_connected" />
      </section>
      <MetricStrip items={[
        { label: 'Web sessions', value: formatNumber(web.sessions || 0) },
        { label: 'Users', value: formatNumber(web.users || 0) },
        { label: 'Active time', value: formatDuration(web.activeDurationMs || 0) },
        { label: 'Page views', value: formatNumber(web.pageViews || 0) },
        { label: 'Recorded events', value: formatNumber(web.events || 0) }
      ]} />
      <div className="management-two-column">
        <section className="admin-card management-panel"><div className="section-head"><div><h2>Browsers</h2><p>Browser families observed on {platform} sessions.</p></div></div><div className="management-ranked-list">{(web.browsers || []).map((item) => <div key={item.label}><span>{item.label}</span><strong>{formatNumber(item.value)}</strong></div>)}</div></section>
        <section className="admin-card management-panel"><div className="section-head"><div><h2>Unavailable native metrics</h2><p>These require app-store or crash-reporting integration.</p></div></div><ul className="requirements-list">{(data.unavailable || []).map((item) => <li key={item}>{item}</li>)}</ul></section>
      </div>
    </div>
  );
}

function CostOverviewPage({ state, onNavigate }) {
  const data = state.data;
  if (!data) return <DataState state={state} />;
  const totals = data.totals || {};
  return (
    <div className="management-page">
      <section className="cost-truth-banner"><div><strong>Costs are separated by evidence</strong><p>Tracked estimates and manual figures are never presented as live provider balances.</p></div><span>Month to date</span></section>
      <MetricStrip items={[
        { label: 'Tracked USD', value: formatMoney(totals.usd || 0, 'USD') },
        { label: 'Tracked INR', value: formatMoney(totals.inr || 0, 'INR') },
        { label: 'Live providers', value: formatNumber(totals.live || 0) },
        { label: 'Estimated providers', value: formatNumber(totals.estimated || 0) },
        { label: 'Manual providers', value: formatNumber(totals.manual || 0) },
        { label: 'Billing unavailable', value: formatNumber(totals.unavailable || 0) }
      ]} />
      <section className="admin-card management-panel">
        <div className="section-head"><div><h2>Provider coverage</h2><p>Open a provider to see usage, cost source, and what is required for live billing.</p></div><span className="last-checked">Updated {formatDate(data.generatedAt)}</span></div>
        <div className="cost-provider-table">
          {(data.providers || []).map((provider) => (
            <button type="button" key={provider.id} onClick={() => onNavigate(`cost-${provider.id}`)}>
              <div><strong>{provider.label}</strong><span>{provider.category}</span></div>
              <StatusBadge status={provider.connection} />
              <SourceBadge source={provider.source} />
              <b>{formatMoney(provider.spend, provider.currency)}</b>
              <span aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function ProviderCostPage({ state }) {
  const data = state.data;
  if (!data) return <DataState state={state} />;
  return (
    <div className="management-page">
      <section className="provider-cost-head">
        <div><span>{data.category}</span><h2>{data.label}</h2><p>{data.sourceLabel}</p></div>
        <div><SourceBadge source={data.source} /><StatusBadge status={data.connection} /></div>
      </section>
      {data.integrationError && <section className="integration-notice"><div><strong>Provider connection failed</strong><p>{data.integrationError}</p></div><StatusBadge status="error" /></section>}
      <MetricStrip currency={data.currency} items={[
        { label: 'Month-to-date cost', value: formatMoney(data.spend, data.currency) },
        { label: 'Balance', value: formatMoney(data.balance, data.currency) },
        { label: 'Budget', value: formatMoney(data.budget, data.currency) },
        ...(data.metrics || []).map((metric) => ({ label: metric.label, value: metricValue(metric, data.currency) }))
      ]} />
      <div className="management-two-column">
        <section className="admin-card management-panel"><div className="section-head"><div><h2>Usage breakdown</h2><p>Recorded inside Lookmefy for the current month.</p></div></div>{(data.breakdown || []).length === 0 ? <div className="management-empty">No detailed usage has been recorded.</div> : <div className="management-table-wrap"><table className="management-table"><thead><tr><th>Item</th><th>Usage</th><th>Tracked size</th><th>Cost</th></tr></thead><tbody>{data.breakdown.map((item) => <tr key={item.label}><td><strong>{humanize(item.label)}</strong></td><td>{formatNumber(item.requests ?? item.files ?? 0)}</td><td>{item.bytes === undefined ? '-' : formatBytes(item.bytes)}</td><td>{item.cost === undefined ? '-' : formatMoney(item.cost, data.currency)}</td></tr>)}</tbody></table></div>}</section>
        <section className="admin-card management-panel"><div className="section-head"><div><h2>Live billing requirements</h2><p>Needed before balance and invoiced spend can be called actual.</p></div></div><ul className="requirements-list">{(data.requirements || []).map((requirement) => <li key={requirement}>{requirement}</li>)}</ul></section>
      </div>
      {(data.daily || []).length > 0 && <section className="admin-card management-panel"><div className="section-head"><div><h2>Daily recorded usage</h2><p>Requests and tracked cost estimates.</p></div></div><div className="management-table-wrap"><table className="management-table"><thead><tr><th>Date</th><th>Requests</th><th>Tracked cost</th></tr></thead><tbody>{data.daily.map((item) => <tr key={item.date}><td>{item.date}</td><td>{formatNumber(item.requests)}</td><td>{formatMoney(item.cost, data.currency)}</td></tr>)}</tbody></table></div></section>}
    </div>
  );
}

export {
  ApiPerformancePage,
  CostOverviewPage,
  FailuresPage,
  GenerationPipelinePage,
  MobileReportPage,
  ProviderCostPage,
  ServiceHealthPage,
  SystemOverviewPage
};
