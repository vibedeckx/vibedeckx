'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api, type RemoteServer, type CrossRemoteAccess } from '@/lib/api';
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
  RefreshCw,
} from 'lucide-react';

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

interface ServerFormState {
  name: string;
}

const emptyForm: ServerFormState = { name: '' };

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
  const [rotating, setRotating] = useState(false);
  const [rotateConfirm, setRotateConfirm] = useState(false);
  // Server the in-flight token request belongs to. A request can outlive the
  // dialog it was opened from — close it and open another remote and a late
  // response would otherwise paint server A's connect command under B's name.
  const tokenRequestRef = useRef<string | null>(null);

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
    setForm({ name: server.name });
    setFormError('');
    setIsFormOpen(true);
  };

  const handleFormSubmit = async () => {
    if (!form.name.trim()) {
      setFormError('Name is required');
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      if (editingServer) {
        if (form.name.trim() !== editingServer.name) {
          await api.updateRemoteServer(editingServer.id, { name: form.name.trim() });
        }
      } else {
        await api.createRemoteServer({ name: form.name.trim() });
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

  // Opening the dialog reads the server's existing token (minting one only on
  // first use), so the connect command a worker was given stays valid.
  const handleShowToken = async (server: RemoteServer) => {
    tokenRequestRef.current = server.id;
    setTokenDialogServer(server);
    setGeneratedToken(null);
    setConnectCommand(null);
    setTokenCopied(false);
    setRotateConfirm(false);
    setRotating(false);
    setGeneratingToken(true);
    try {
      const result = await api.getRemoteServerConnectToken(server.id);
      if (tokenRequestRef.current !== server.id) return;
      setGeneratedToken(result.token);
      setConnectCommand(result.connectCommand);
    } catch (e) {
      if (tokenRequestRef.current !== server.id) return;
      tokenRequestRef.current = null;
      setFormError(e instanceof Error ? e.message : 'Failed to load token');
      setTokenDialogServer(null);
    } finally {
      if (tokenRequestRef.current === server.id) setGeneratingToken(false);
    }
  };

  const handleRotateToken = async (server: RemoteServer) => {
    setRotating(true);
    setTokenCopied(false);
    try {
      const result = await api.rotateRemoteServerConnectToken(server.id);
      if (tokenRequestRef.current === server.id) {
        setGeneratedToken(result.token);
        setConnectCommand(result.connectCommand);
        setRotateConfirm(false);
      }
      await loadServers();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rotate token');
    } finally {
      if (tokenRequestRef.current === server.id) setRotating(false);
    }
  };

  const handleRevokeToken = async (server: RemoteServer) => {
    try {
      await api.revokeRemoteServerConnectToken(server.id);
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

  // --- Cross-remote access ---

  const handleAccessChange = async (server: RemoteServer, access: CrossRemoteAccess) => {
    try {
      const updated = await api.updateRemoteServer(server.id, { crossRemoteAccess: access });
      setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update access');
    }
  };

  const upgradeHint =
    'Update the vibedeckx package on the worker machine, then restart `vibedeckx connect`.';

  // Phase 3 upgrade nudge: advisory only, nothing is blocked. A server that
  // has never connected has nothing to report yet — no chip, no badge.
  const renderWorkerVersion = (server: RemoteServer) => {
    if (!server.worker_version) {
      if (!server.last_connected_at) return null;
      return (
        <div className="mt-0.5 text-[11px] text-muted-foreground" title={upgradeHint}>
          version unknown · upgrade recommended
        </div>
      );
    }
    const badge =
      server.worker_update_status === 'behind-min' ? (
        <span className="text-red-500" title={upgradeHint}>
          upgrade required
        </span>
      ) : server.worker_update_status === 'behind-latest' ? (
        <span className="text-amber-500" title={upgradeHint}>
          update available → v{server.latest_worker_version}
        </span>
      ) : null;
    return (
      <div className="mt-0.5 text-[11px]">
        <span className="text-muted-foreground">v{server.worker_version}</span>
        {badge && <span className="ml-1.5">{badge}</span>}
      </div>
    );
  };

  const renderStatusDot = (server: RemoteServer) => {
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
              <TableHead>Status</TableHead>
              <TableHead>Cross-remote access</TableHead>
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
                <TableCell className="font-mono text-xs text-muted-foreground">
                  <div>{server.status === 'online' ? 'Connected' : 'Waiting for connection...'}</div>
                  {renderWorkerVersion(server)}
                </TableCell>
                <TableCell>
                  <Select
                    value={server.cross_remote_access}
                    onValueChange={(value) => handleAccessChange(server, value as CrossRemoteAccess)}
                  >
                    <SelectTrigger className="w-[190px] text-[12.5px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off" className="text-[12.5px]">Off</SelectItem>
                      <SelectItem value="read" className="text-[12.5px]">Diagnostic read</SelectItem>
                      <SelectItem value="exec" className="text-[12.5px]">Command execution</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleShowToken(server)}
                      title="Connect token"
                      className="h-8 w-8"
                    >
                      <KeyRound className="h-4 w-4" />
                    </Button>
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

      <p className="text-xs text-muted-foreground">
        When enabled, agents running on your other machines can reach this one.
        <strong> Diagnostic read</strong> exposes files, directories and the process list —
        including any secrets in logs and config files.
        <strong> Command execution</strong> additionally allows arbitrary shell commands.
        Off by default.
      </p>

      {/* Add/Edit Server Dialog */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingServer ? 'Edit Server' : 'Add Remote Server'}
            </DialogTitle>
            <DialogDescription>
              {editingServer
                ? 'Update the server name.'
                : 'Add a new remote server, then generate a connect token and run the connect command on the remote machine.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
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
            tokenRequestRef.current = null;
            setTokenDialogServer(null);
            setGeneratedToken(null);
            setConnectCommand(null);
            setRotateConfirm(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect Token</DialogTitle>
            <DialogDescription>
              Use this token to connect a remote node to{' '}
              <span className="font-semibold">{tokenDialogServer?.name}</span>.
              It stays the same every time you open this dialog — rotate it to
              issue a replacement.
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
                  Run this command on the remote machine to establish the reverse connection.
                </p>
                {rotateConfirm && (
                  <p className="text-xs text-destructive">
                    Rotating invalidates the current token immediately. Any worker
                    still using it will fail to reconnect until you re-run the new command.
                  </p>
                )}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            {generatedToken && tokenDialogServer && (
              <div className="mr-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  disabled={rotating}
                  onClick={() => {
                    if (rotateConfirm) handleRotateToken(tokenDialogServer);
                    else setRotateConfirm(true);
                  }}
                >
                  {rotating ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  {rotateConfirm ? 'Confirm rotate' : 'Rotate Token'}
                </Button>
                <Button
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    handleRevokeToken(tokenDialogServer);
                    tokenRequestRef.current = null;
                    setTokenDialogServer(null);
                    setGeneratedToken(null);
                  }}
                >
                  Revoke Token
                </Button>
              </div>
            )}
            <Button
              variant="outline"
              onClick={() => {
                tokenRequestRef.current = null;
                setTokenDialogServer(null);
                setGeneratedToken(null);
                setConnectCommand(null);
                setRotateConfirm(false);
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
