import React from 'react';
import { Volume2, BatteryCharging, Clipboard } from 'lucide-react';

interface SystemWidgetProps {
  type: 'volume' | 'battery' | 'clipboard';
  value: string | number;
}

export const SystemWidget: React.FC<SystemWidgetProps> = ({ type, value }) => {
  return (
    <div className="flex items-center justify-between w-full h-full px-4 text-white">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-white/10 text-white flex items-center justify-center flex-shrink-0">
          {type === 'volume' && <Volume2 size={16} />}
          {type === 'battery' && <BatteryCharging size={16} className="text-emerald-400" />}
          {type === 'clipboard' && <Clipboard size={16} className="text-blue-400" />}
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] text-neutral-400 font-medium uppercase tracking-wider">
            {type === 'volume' ? 'Volume Sistem' : type === 'battery' ? 'Status Baterai' : 'Clipboard Disalin'}
          </span>
          <span className="text-xs font-semibold text-white truncate max-w-[200px]">{value}</span>
        </div>
      </div>
    </div>
  );
};