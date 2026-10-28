import { useState } from 'react';
import { post, get, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { useLiveEvents } from '../lib/live';
import { ConfirmDialog } from './ui';

interface SystemState {
  emergencyStop: boolean;
}

/**
 * Always-visible emergency stop. Activation needs no confirmation (speed matters);
 * clearing it is admin-only and confirmed, and never resumes tasks by itself.
 */
export function EmergencyStop() {
  const { can } = useAuth();
  const state = useAsync(() => get<SystemState>('/api/system/state'));
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pending, setPending] = useState(false);
  useLiveEvents(['system.emergency_stop'], () => void state.reload());

  const stop = async () => {
    setPending(true);
    setError(null);
    try {
      await post('/api/system/emergency-stop', { source: 'web' });
      await state.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  const clear = async () => {
    setPending(true);
    try {
      await post('/api/system/emergency-stop/clear', { confirm: true });
      setConfirmClear(false);
      await state.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  const active = state.data?.emergencyStop;
  return (
    <div className="estop">
      {active ? (
        <>
          <span className="badge badge-danger" role="status">
            ■ Emergency stop active
          </span>
          {can('system:admin') && (
            <button type="button" className="btn btn-small" onClick={() => setConfirmClear(true)}>
              Clear stop…
            </button>
          )}
        </>
      ) : (
        <button type="button" className="btn btn-danger btn-estop" onClick={stop} disabled={pending || !can('system:emergency_stop')} aria-describedby="estop-help">
          ■ Emergency stop
        </button>
      )}
      <span id="estop-help" className="sr-only">
        Immediately cancels running agent actions and pauses every active task.
      </span>
      {error && (
        <span role="alert" className="estop-error">
          {error}
        </span>
      )}
      <ConfirmDialog open={confirmClear} title="Clear emergency stop?" confirmLabel="Clear emergency stop" onConfirm={clear} onCancel={() => setConfirmClear(false)} pending={pending}>
        <p>The agent will accept operations again. Paused tasks stay paused until you resume each one individually.</p>
      </ConfirmDialog>
    </div>
  );
}
