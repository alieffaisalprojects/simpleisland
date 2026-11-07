import React from 'react';
import { Clock, Pause, Play, RotateCcw } from 'lucide-react';

interface TimerWidgetProps {
  timeLeft: number; 
  isRunning: boolean;
  onToggle: () => void;
  onReset: () => void;
}

export const TimerWidget: React.FC<TimerWidgetProps> = ({ timeLeft, isRunning, onToggle, onReset }) => {
  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const formattedTime = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  return (
    <div className="flex items-center justify-between w-full h-full px-4 text-white">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center flex-shrink-0">
          <Clock size={16} />
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] text-neutral-400 font-medium uppercase tracking-wider">Timer Aktif</span>
          <span className="text-sm font-mono font-bold tracking-widest text-amber-300">{formattedTime}</span>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          className="p-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
        >
          {isRunning ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onReset(); }}
          className="p-1.5 rounded-full hover:bg-white/10 hover:text-white text-neutral-400 transition-colors"
        >
          <RotateCcw size={13} />
        </button>
      </div>
    </div>
  );
};