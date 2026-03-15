'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, type RemoteServer, type RemoteServerConnectionMode } from '@/lib/api';
import {
  Globe,
  Plus,
  Pencil,
  Trash2,
  PlugZap,
  Check,
  X,
  Loader2,
  KeyRound,
  Copy,
} from 'lucide-react';

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

interface ServerFormState {
  name: string;
  url: string;
  apiKey: string;
  connectionMode: RemoteServerConnectionMode;
}

const emptyForm: ServerFormState = { name: '', url: '', apiKey: '', connectionMode: 'outbound' };

export function RemoteServersSettings() {
  const [servers, setServers] = useState<RemoteServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Add/Edit dialog
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<RemoteServer | null>(null);
  const [form, setForm] = useState<ServerFormState>(emptyForm);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<RemoteServer | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Test connection status per server
  const [testStatuses, setTestStatuses] = useState<Record<string, TestStatus>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});

  // Token dialog
  const [tokenDialogServer, setTokenDialogServer] = useState<RemoteServer | null>(null);
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [connectCommand, setConnectCommand] = useState<string | null>(null);
  const [generatingToken, setGeneratingToken] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);

  const loadServers = useCallback(async () => {
    try {
      const data = await api.getRemoteServers();
      setServers(data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load servers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  // Refresh servers periodically to update status
  useEffect(() => {
    const interval = setInterval(loadServers, 15000);
    const onFocus = () => loadServers();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadServers]);

  // --- Add / Edit ---

  const openAddDialog = () => {
    setEditingServer(null);
    setForm(emptyForm);
    setFormError('');
    setIsFormOpen(true);
  };

  const openEditDialog = (server: RemoteServer) => {
    setEditingServer(server);
    setForm({ name: server.name, url: server.url, apiKey: '', connectionMode: server.connection_mode });
    setFormError('');
    setIsFormOpen(true);
  };

  const handleFormSubmit = async () => {
    if (!form.name.trim()) {
      setFormError('Name is required');
      return;
    }
    if (form.connectionMode === 'outbound' && !form.url.trim()) {
      setFormError('URL is required for outbound servers');
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      if (editingServer) {
        const opts: { name?: string; url?: string; apiKey?: string } = {};
        if (form.name.trim() !== editingServer.name) opts.name = form.name.trim();
        if (form.url.trim() !== editingServer.url) opts.url = form.url.trim();
        if (form.apiKey.trim()) opts.apiKey = form.apiKey.trim();
        await api.updateRemoteServer(editingServer.id, opts);
      } else {
        await api.createRemoteServer({
          name: form.name.trim(),
          url: form.url.trim(),
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
          connectionMode: form.connectionMode,
        });
      }
      setIsFormOpen(false);
      await loadServers();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to save server');
    } finally {
      setSaving(false);
    }
  };

  // --- Delete ---

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteRemoteServer(deleteTarget.id);
      setDeleteTarget(null);
      await loadServers();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to delete server');
    } finally {
      setDeleting(false);
    }
  };

  // --- Test Connection ---

  const handleTestConnection = async (server: RemoteServer) => {
    setTestStatuses((prev) => ({ ...prev, [server.id]: 'testing' }));
    setTestErrors((prev) => {
      const next = { ...prev };
      delete next[server.id];
      return next;
    });
    try {
      const result = await api.testRemoteServer(server.id);
      setTestStatuses((prev) => ({
        ...prev,
        [server.id]: result.success ? 'success' : 'error',
      }));
      if (!result.success) {
        setTestErrors((prev) => ({ ...prev, [server.id]: 'Connection failed' }));
      }
    } catch (e) {
      setTestStatuses((prev) => ({ ...prev, [server.id]: 'error' }));
      setTestErrors((prev) => ({
        ...prev,
        [server.id]: e instanceof Error ? e.message : 'Test failed',
      }));
    }
  };

  // --- Token Generation ---

  const handleGenerateToken = async (server: RemoteServer) => {
    setTokenDialogServer(server);
    setGeneratedToken(null);
    setConnectCommand(null);
    setTokenCopied(false);
    setGeneratingToken(true);
    try {
      const result = await api.generateRemoteServerToken(server.id);
      setGeneratedToken(result.token);
      setConnectCommand(result.connectCommand);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to generate token');
      setTokenDialogServer(null);
    } finally {
      setGeneratingToken(false);
    }
  };

  const handleRevokeToken = async (server: RemoteServer) => {
    try {
      await api.revokeRemoteServerToken(server.id);
      await loadServers();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke token');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  };

  const renderStatusDot = (server: RemoteServer) => {
    if (server.connection_mode !== 'inbound') return null;
    const isOnline = server.status === 'online';
    return (
      <span
        className={`inline-block h-2.5 w-2.5 rounded-full mr-2 ${
          isOnline ? 'bg-green-500' : 'bg-gray-400'
        }`}
        title={isOnline ? 'Online' : 'Offline'}
      />
    );
  };

  const renderTestButton = (server: RemoteServer) => {
    const status = testStatuses[server.id] || 'idle';
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={() => handleTestConnection(server)}
        disabled={status === 'testing'}
        title="Test connection"
        className="h-8 w-8"
      >
        {status === 'testing' ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : status === 'success' ? (
          <Check className="h-4 w-4 text-green-500" />
        ) : status === 'error' ? (
          <X className="h-4 w-4 text-red-500" />
        ) : (
          <PlugZap className="h-4 w-4" />
        )}
      </Button>
    );
  };

  // --- Render ---

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Remote Servers</h3>
          <p className="text-xs text-muted-foreground">
            Manage globally available remote servers
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={openAddDialog}>
          <Plus className="h-4 w-4 mr-1.5" />
          Add Server
        </Button>
      </div>

      {error && (
        <p className="text-sm text-red-500">{error}</p>
      )}

      {servers.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground border rounded-md">
          <Globe className="h-8 w-8 mx-auto mb-2 opacity-40" />
          No remote servers configured
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>URL / Status</TableHead>
              <TableHead className="w-[180px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {servers.map((server) => (
              <TableRow key={server.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center">
                    {renderStatusDot(server)}
                    {server.name}
                  </div>
                </TableCell>
                <TableCell>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    server.connection_mode === 'inbound'
                      ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                      : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400'
                  }`}>
                    {server.connection_mode === 'inbound' ? 'Inbound' : 'Outbound'}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {server.connection_mode === 'inbound'
                    ? (server.status === 'online' ? 'Connected' : 'Waiting for connection...')
                    : server.url}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {server.connection_mode === 'inbound' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleGenerateToken(server)}
                        title="Generate connect token"
                        className="h-8 w-8"
                      >
                        <KeyRound className="h-4 w-4" />
                      </Button>
                    )}
                    {renderTestButton(server)}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEditDialog(server)}
                      title="Edit server"
                      className="h-8 w-8"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteTarget(server)}
                      title="Delete server"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  {testErrors[server.id] && (
                    <p className="text-xs text-red-500 mt-1 text-right">
                      {testErrors[server.id]}
                    </p>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Add/Edit Server Dialog */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingServer ? 'Edit Server' : 'Add Remote Server'}
            </DialogTitle>
            <DialogDescription>
              {editingServer
                ? 'Update the server connection details.'
                : 'Add a new remote server to the global registry.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!editingServer && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Connection Mode</label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={form.connectionMode === 'outbound' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setForm((f) => ({ ...f, connectionMode: 'outbound' }))}
                  >
                    Outbound
                  </Button>
                  <Button
                    type="button"
                    variant={form.connectionMode === 'inbound' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setForm((f) => ({ ...f, connectionMode: 'inbound' }))}
                  >
                    Inbound
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {form.connectionMode === 'outbound'
                    ? 'Server connects outbound to the remote node (remote must have a public URL).'
                    : 'Remote node connects inbound to this server (no public URL needed on remote).'}
                </p>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium">Name</label>
              <Input
                value={form.name}
                onChange={(e) => {
                  setForm((f) => ({ ...f, name: e.target.value }));
                  setFormError('');
                }}
                placeholder="My Remote Server"
              />
            </div>

            {(form.connectionMode === 'outbound' || editingServer) && (
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  URL{form.connectionMode === 'inbound' && !editingServer ? ' (optional)' : ''}
                </label>
                <Input
                  value={form.url}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, url: e.target.value }));
                    setFormError('');
                  }}
                  placeholder="http://remote-server:5173"
                />
              </div>
            )}

            {form.connectionMode === 'outbound' && (
              <div className="space-y-2">
                <label className="text-sm font-medium">API Key</label>
                <Input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, apiKey: e.target.value }));
                    setFormError('');
                  }}
                  placeholder={editingServer ? '(unchanged)' : 'Optional'}
                />
              </div>
            )}

            {formError && (
              <p className="text-sm text-red-500">{formError}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleFormSubmit} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {editingServer ? 'Save Changes' : 'Add Server'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Token Generation Dialog */}
      <Dialog
        open={tokenDialogServer !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTokenDialogServer(null);
            setGeneratedToken(null);
            setConnectCommand(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect Token</DialogTitle>
            <DialogDescription>
              Use this token to connect a remote node to{' '}
              <span className="font-semibold">{tokenDialogServer?.name}</span>.
              The token is shown only once.
            </DialogDescription>
          </DialogHeader>

          {generatingToken ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : generatedToken ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Connect Command</label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={connectCommand || ''}
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={() => copyToClipboard(connectCommand || '')}
                    title="Copy command"
                  >
                    {tokenCopied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Run this command on the remote machine. Replace {'<server-url>'} with this server&apos;s public URL.
                </p>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            {generatedToken && tokenDialogServer && (
              <Button
                variant="outline"
                className="mr-auto text-destructive hover:text-destructive"
                onClick={() => {
                  handleRevokeToken(tokenDialogServer);
                  setTokenDialogServer(null);
                  setGeneratedToken(null);
                }}
              >
                Revoke Token
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                setTokenDialogServer(null);
                setGeneratedToken(null);
                setConnectCommand(null);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Server</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{' '}
              <span className="font-semibold">{deleteTarget?.name}</span>? This
              will also remove it from any projects that reference it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
