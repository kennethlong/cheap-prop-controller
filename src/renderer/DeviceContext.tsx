import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DeviceStatus } from "../desktop-api";

interface DeviceContextValue {
  status: DeviceStatus;
  setStatus(status: DeviceStatus): void;
  busy: string;
  run<T>(label: string, task: () => Promise<T>, priority?: boolean): Promise<T>;
}
const DeviceContext = createContext<DeviceContextValue | null>(null);

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DeviceStatus>({ connected: false });
  const [busy, setBusy] = useState("");
  const operation = useRef(0);
  const busyRef = useRef("");
  useEffect(() => {
    if (!window.cpc) return;
    let current = true;
    let receivedStatus = false;
    const off = window.cpc.onDeviceStatus((next) => {
      receivedStatus = true;
      if (current) setStatus(next);
    });
    void window.cpc
      .getDeviceStatus()
      .then((next) => {
        if (current && !receivedStatus) setStatus(next);
      })
      .catch(() => {});
    return () => {
      current = false;
      off();
    };
  }, []);
  const run = async <T,>(
    label: string,
    task: () => Promise<T>,
    priority = false,
  ): Promise<T> => {
    if (busyRef.current && !priority)
      throw new Error(
        `Wait for ${busyRef.current.toLowerCase()} to finish, or press STOP.`,
      );
    const token = ++operation.current;
    busyRef.current = label;
    setBusy(label);
    try {
      return await task();
    } finally {
      if (operation.current === token) {
        busyRef.current = "";
        setBusy("");
      }
    }
  };
  return (
    <DeviceContext.Provider value={{ status, setStatus, busy, run }}>
      {children}
    </DeviceContext.Provider>
  );
}

export function useDevice() {
  const value = useContext(DeviceContext);
  if (!value) throw new Error("DeviceProvider is required.");
  return value;
}
