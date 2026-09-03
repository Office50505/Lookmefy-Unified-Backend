import { useEffect, useMemo, useState } from 'react';

const SECTION_OPTIONS = [
  { id: 'user-operations', label: 'User Operations' },
  { id: 'system-management', label: 'System Management' },
  { id: 'cost-management', label: 'Cost Management' }
];

function roleLabel(admin) {
  if (admin.status === 'pending') return 'Unassigned';
  return admin.role === 'master' ? 'Master' : 'Developer';
}

function formatAdminDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Never' : date.toLocaleString();
}

function AccessTags({ admin }) {
  const sections = admin.role === 'master' ? SECTION_OPTIONS.map((section) => section.id) : admin.sectionAccess || [];
  if (!sections.length) return <div className="role-access-tags"><span className="no-access">No permissions</span></div>;
  return (
    <div className="role-access-tags">
      {SECTION_OPTIONS.filter((section) => sections.includes(section.id)).map((section) => (
        <span key={section.id}>{section.label}</span>
      ))}
    </div>
  );
}

function AdminRolesPage({ request, currentAdmin, onSessionRefresh }) {
  const [state, setState] = useState({ admins: [], loading: true, error: '' });
  const [form, setForm] = useState(null);
  const [editingId, setEditingId] = useState('');
  const [pendingRevoke, setPendingRevoke] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const activeCount = useMemo(() => state.admins.filter((admin) => admin.status === 'active').length, [state.admins]);
  const pendingCount = useMemo(() => state.admins.filter((admin) => admin.status === 'pending').length, [state.admins]);
  const masterCount = useMemo(() => state.admins.filter((admin) => admin.role === 'master' && admin.status === 'active').length, [state.admins]);
  const visibleAdmins = useMemo(() => [...state.admins].sort((left, right) => {
    const priority = { pending: 0, active: 1, disabled: 2 };
    return (priority[left.status] ?? 3) - (priority[right.status] ?? 3) || left.name.localeCompare(right.name);
  }), [state.admins]);

  const load = async () => {
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const data = await request('/admin/roles');
      setState({ admins: data.admins || [], loading: false, error: '' });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openEdit = (admin) => {
    setEditingId(admin.id);
    setMessage('');
    setForm({
      name: admin.name,
      email: admin.email,
      role: admin.role,
      status: admin.status === 'pending' ? 'active' : admin.status,
      sectionAccess: [...(admin.sectionAccess || [])],
      wasPending: admin.status === 'pending'
    });
  };

  const toggleSection = (sectionId) => {
    setForm((current) => ({
      ...current,
      sectionAccess: current.sectionAccess.includes(sectionId)
        ? current.sectionAccess.filter((item) => item !== sectionId)
        : [...current.sectionAccess, sectionId]
    }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await request(`/admin/roles/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: form.role, status: form.status, sectionAccess: form.sectionAccess })
      });
      setForm(null);
      setEditingId('');
      setMessage(form.wasPending ? 'Access request approved.' : 'Administrator access updated.');
      await load();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const revokeSessions = async () => {
    if (!pendingRevoke) return;
    setBusy(true);
    try {
      const data = await request(`/admin/roles/${pendingRevoke.id}/revoke-sessions`, { method: 'POST' });
      if (data.token) onSessionRefresh({ token: data.token, admin: data.admin });
      setMessage(`Sessions revoked for ${pendingRevoke.name}.`);
      setPendingRevoke(null);
      await load();
    } catch (error) {
      setMessage(error.message);
      setPendingRevoke(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="management-page roles-page">
      <section className="roles-summary" aria-label="Administrator access summary">
        <div><span>Administrators</span><strong>{state.admins.length}</strong></div>
        <div><span>Pending approval</span><strong>{pendingCount}</strong></div>
        <div><span>Active</span><strong>{activeCount}</strong></div>
        <div><span>Active masters</span><strong>{masterCount}</strong></div>
      </section>

      <section className="admin-card management-panel">
        <div className="section-head">
          <div><h2>Roles and access</h2><p>New administrators choose their own password and remain permissionless until a Master approves them.</p></div>
          <button type="button" onClick={load} disabled={state.loading}>Refresh</button>
        </div>
        {state.error && <div className="management-error">{state.error}</div>}
        {message && <div className="roles-inline-message" role="status">{message}</div>}
        {state.loading ? <div className="management-empty">Loading administrators...</div> : (
          <div className="management-table-wrap">
            <table className="management-table roles-table">
              <thead><tr><th>Administrator</th><th>Role</th><th>Access</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead>
              <tbody>
                {visibleAdmins.map((admin) => (
                  <tr key={admin.id} className={admin.status === 'pending' ? 'pending-admin-row' : ''}>
                    <td><div className="role-admin-identity"><strong>{admin.name}</strong><span>{admin.email}</span>{admin.id === currentAdmin?.id && <small>Current account</small>}</div></td>
                    <td><span className={`role-badge ${admin.status === 'pending' ? 'unassigned' : admin.role}`}>{roleLabel(admin)}</span></td>
                    <td><AccessTags admin={admin} /></td>
                    <td><span className={`role-status ${admin.status}`}>{admin.status}</span></td>
                    <td>{formatAdminDate(admin.lastLoginAt)}</td>
                    <td><div className="role-row-actions"><button type="button" onClick={() => openEdit(admin)} disabled={admin.id === currentAdmin?.id}>{admin.status === 'pending' ? 'Review' : 'Edit'}</button><button type="button" onClick={() => setPendingRevoke(admin)} disabled={admin.status === 'pending'}>Revoke sessions</button></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {form && (
        <div className="roles-dialog-backdrop" role="presentation">
          <section className="roles-dialog" role="dialog" aria-modal="true" aria-labelledby="roles-dialog-title">
            <div className="roles-dialog-head"><div><span>{form.wasPending ? 'Access request' : 'Administrator access'}</span><h2 id="roles-dialog-title">{form.wasPending ? `Approve ${form.name}` : 'Edit role and access'}</h2></div><button type="button" onClick={() => setForm(null)} aria-label="Close">×</button></div>
            <div className="role-request-identity"><strong>{form.name}</strong><span>{form.email}</span></div>
            <form onSubmit={submit}>
              <div className="roles-form-grid">
                <label className="field"><span>Role</span><select value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value, sectionAccess: event.target.value === 'master' ? SECTION_OPTIONS.map((section) => section.id) : current.sectionAccess }))}><option value="developer">Developer</option><option value="master">Master</option></select></label>
                <label className="field"><span>Status</span><select value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value, ...(event.target.value === 'pending' ? { role: 'developer', sectionAccess: [] } : {}) }))}><option value="active">Active</option><option value="pending">Pending</option><option value="disabled">Disabled</option></select></label>
              </div>
              <fieldset className="role-section-picker" disabled={form.role === 'master' || form.status === 'pending'}>
                <legend>Section access</legend>
                {SECTION_OPTIONS.map((section) => <label key={section.id}><input type="checkbox" checked={form.role === 'master' || form.sectionAccess.includes(section.id)} onChange={() => toggleSection(section.id)} /><span>{section.label}</span></label>)}
              </fieldset>
              {message && <p className="form-message">{message}</p>}
              <div className="roles-dialog-actions"><button type="button" onClick={() => setForm(null)}>Cancel</button><button className="primary-action" type="submit" disabled={busy}>{busy ? 'Saving...' : form.wasPending ? 'Approve access' : 'Save access'}</button></div>
            </form>
          </section>
        </div>
      )}

      {pendingRevoke && (
        <div className="roles-dialog-backdrop" role="presentation">
          <section className="roles-dialog compact" role="dialog" aria-modal="true" aria-labelledby="revoke-sessions-title">
            <div className="roles-dialog-head"><div><span>Session security</span><h2 id="revoke-sessions-title">Revoke {pendingRevoke.name}'s sessions?</h2></div></div>
            <p>Every existing session for this administrator will stop working. Their password will stay unchanged.</p>
            <div className="roles-dialog-actions"><button type="button" onClick={() => setPendingRevoke(null)}>Cancel</button><button className="danger-action" type="button" onClick={revokeSessions} disabled={busy}>{busy ? 'Revoking...' : 'Revoke sessions'}</button></div>
          </section>
        </div>
      )}
    </div>
  );
}

export { AdminRolesPage, SECTION_OPTIONS };
