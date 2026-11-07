import { useCallback, useEffect, useRef, useState } from "react";

export const useTimer = (initialSeconds = 1500) => {
  const [timeLeft, setTimeLeft] = useState(initialSeconds);
  const [isRunning, setIsRunning] = useState(false);
  const deadlineRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isRunning) {
      deadlineRef.current = null;
      return;
    }
    deadlineRef.current = Date.now() + timeLeft * 1000;
    const interval = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil(((deadlineRef.current ?? Date.now()) - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining <= 0) {
        setIsRunning(false);
        deadlineRef.current = null;
      }
    }, 200);
    return () => window.clearInterval(interval);
  }, [isRunning]);

  const toggleTimer = useCallback(() => {
    setIsRunning((running) => !running);
  }, []);

  const resetTimer = useCallback(() => {
    setIsRunning(false);
    deadlineRef.current = null;
    setTimeLeft(initialSeconds);
  }, [initialSeconds]);

  return { timeLeft, isRunning, toggleTimer, resetTimer };
};
