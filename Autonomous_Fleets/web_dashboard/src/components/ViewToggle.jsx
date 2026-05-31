export default function ViewToggle({ mode, onToggle }) {
  return (
    <div className="view-toggle">
      <button
        className={`view-toggle-btn ${mode === '2d' ? 'view-toggle-active' : ''}`}
        onClick={() => onToggle('2d')}
      >
        2D Map
      </button>
      <button
        className={`view-toggle-btn ${mode === '3d' ? 'view-toggle-active' : ''}`}
        onClick={() => onToggle('3d')}
      >
        3D Map
      </button>
    </div>
  );
}
