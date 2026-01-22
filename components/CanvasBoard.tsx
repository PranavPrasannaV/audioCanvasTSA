import React, { useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { CanvasElement } from '../types';

interface CanvasBoardProps {
  elements: CanvasElement[];
}

export interface CanvasBoardHandle {
  getSnapshotBlob: () => Promise<Blob | null>;
  exportAs: (format: 'svg' | 'png' | 'jpg', filename?: string) => Promise<void>;
}

const CanvasBoard = forwardRef<CanvasBoardHandle, CanvasBoardProps>(({ elements }, ref) => {
  const svgRef = useRef<SVGSVGElement>(null);

  useImperativeHandle(ref, () => ({
    getSnapshotBlob: async () => {
      if (!svgRef.current) return null;

      // Serialize SVG
      const svgData = new XMLSerializer().serializeToString(svgRef.current);
      const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      // Draw to canvas to get JPEG
      const img = new Image();

      return new Promise((resolve) => {
        img.onload = () => {
          const canvas = document.createElement('canvas');
          // Use fixed size for consistency in AI vision
          canvas.width = 1024;
          canvas.height = 1024;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            URL.revokeObjectURL(url);
            resolve(null);
            return;
          }

          // Draw white background
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // Draw SVG
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          canvas.toBlob((b) => {
            URL.revokeObjectURL(url);
            resolve(b);
          }, 'image/jpeg', 0.8);
        };
        img.src = url;
      });
    },

    exportAs: async (format: 'svg' | 'png' | 'jpg', filename?: string) => {
      if (!svgRef.current) return;

      const baseName = filename || `canvas_${Date.now()}`;

      // Helper to trigger download
      const downloadBlob = (blob: Blob, name: string) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };

      if (format === 'svg') {
        // Export as SVG
        const svgData = new XMLSerializer().serializeToString(svgRef.current);
        const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        downloadBlob(blob, `${baseName}.svg`);
        return;
      }

      // For PNG and JPG, we need to render to canvas first
      const svgData = new XMLSerializer().serializeToString(svgRef.current);
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();

      return new Promise<void>((resolve) => {
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = 1920;
          canvas.height = 1920;
          const ctx = canvas.getContext('2d');

          if (!ctx) {
            URL.revokeObjectURL(url);
            resolve();
            return;
          }

          // Draw white background
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // Draw SVG
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);

          if (format === 'png') {
            canvas.toBlob((blob) => {
              if (blob) downloadBlob(blob, `${baseName}.png`);
              resolve();
            }, 'image/png');
          } else {
            // jpg
            canvas.toBlob((blob) => {
              if (blob) downloadBlob(blob, `${baseName}.jpg`);
              resolve();
            }, 'image/jpeg', 0.9);
          }
        };
        img.src = url;
      });
    },
  }));

  return (
    <div className="w-full h-full bg-white rounded-lg shadow-inner overflow-hidden relative">
      <svg
        ref={svgRef}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="w-full h-full block"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect width="100" height="100" fill="#f8fafc" />

        {elements.map((el) => {
          switch (el.type) {
            case 'rect':
              return (
                <rect
                  key={el.id}
                  x={el.x}
                  y={el.y}
                  width={el.width || 10}
                  height={el.height || 10}
                  fill={el.fill}
                  stroke="black"
                  strokeWidth="0.5"
                />
              );
            case 'circle':
              return (
                <circle
                  key={el.id}
                  cx={el.x}
                  cy={el.y}
                  r={el.radius || 5}
                  fill={el.fill}
                  stroke="black"
                  strokeWidth="0.5"
                />
              );
            case 'triangle':
              // Simple equilateral triangle logic based on width
              const w = el.width || 10;
              const h = (w * Math.sqrt(3)) / 2;
              const x1 = el.x;
              const y1 = el.y - h / 2;
              const x2 = el.x - w / 2;
              const y2 = el.y + h / 2;
              const x3 = el.x + w / 2;
              const y3 = el.y + h / 2;
              return (
                <polygon
                  key={el.id}
                  points={`${x1},${y1} ${x2},${y2} ${x3},${y3}`}
                  fill={el.fill}
                  stroke="black"
                  strokeWidth="0.5"
                />
              );
            case 'text':
              return (
                <text
                  key={el.id}
                  x={el.x}
                  y={el.y}
                  fill={el.fill}
                  fontSize={el.fontSize || 5}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  style={{ userSelect: 'none' }}
                >
                  {el.text}
                </text>
              );
            default:
              return null;
          }
        })}
      </svg>

      {/* Collaboration Indicator Mock */}
      <div className="absolute top-2 right-2 flex space-x-1">
        {/* In a real app, this would show avatars of connected peers */}
      </div>
    </div>
  );
});

export default CanvasBoard;
