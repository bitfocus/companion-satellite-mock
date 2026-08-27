import type { ControlTile } from './App.js'

/**
 * What the server believes it last sent to each control.
 *
 * This is the alignment tool: put it next to the real device and any difference is a client bug.
 * The preview is always a PNG rendered server-side from the same style the device was sent, so it
 * shows what *was sent*, not a browser re-interpretation of it.
 */
export function SurfaceMirror({
	tiles,
	gridSize,
}: {
	tiles: ControlTile[]
	gridSize: { rows: number; columns: number }
}) {
	if (tiles.length === 0) {
		return (
			<section className="card">
				<h2>Surface</h2>
				<p className="muted">No surface registered yet.</p>
			</section>
		)
	}

	return (
		<section className="card" data-testid="surface-panel">
			<h2>
				Surface{' '}
				<span className="muted">
					{gridSize.columns}×{gridSize.rows}
				</span>
			</h2>
			<div
				className="grid"
				style={{
					gridTemplateColumns: `repeat(${Math.max(1, gridSize.columns)}, minmax(0, 1fr))`,
					gridTemplateRows: `repeat(${Math.max(1, gridSize.rows)}, minmax(0, 1fr))`,
				}}
			>
				{tiles.map((tile) => (
					<figure
						key={tile.id}
						className={tile.style.pressed ? 'tile pressed' : 'tile'}
						// Place each tile at its real coordinate. The client may declare controls in any
						// order, and a manifest surface may have gaps; flowing them in array order scrambles
						// both. 1-based because CSS grid lines start at 1.
						style={{ gridColumn: tile.column + 1, gridRow: tile.row + 1 }}
					>
						<img src={tile.preview} alt={tile.style.text || tile.id} />
						<figcaption>
							<span className="tile-id">{tile.id}</span>
							{tile.style.type !== 'BUTTON' && <span className="tile-type">{tile.style.type}</span>}
						</figcaption>
					</figure>
				))}
			</div>
			<p className="hint">
				Rendered from the style last sent to each control. Tiles the client did not request a bitmap for are
				shown anyway, so the colour and text are still visible.
			</p>
		</section>
	)
}
