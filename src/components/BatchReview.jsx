import { useEffect, useRef, useState } from "react";

export function BatchReview({ sessions, onConfirm, onClose }) {
  const dialog = useRef(null);
  const [stage, setStage] = useState(1);
  useEffect(() => { dialog.current.showModal(); }, []);
  return <dialog ref={dialog} className="batch-dialog" onCancel={onClose}>
    <span className="eyebrow">Batch export · confirmation {stage} of 2</span>
    <h2>{stage === 1 ? "Check the selected chats" : "Ready to export these chats?"}</h2>
    <p>{sessions.length} conversations will be included. Review the names below before continuing.</p>
    <ul className="review-titles">{sessions.map((s, i) => <li key={s.id || i}>{s.title}</li>)}</ul>
    <div className="actions">
      <button className="button secondary" onClick={onClose}>Cancel</button>
      <button className="button" onClick={stage === 1 ? () => setStage(2) : onConfirm}>{stage === 1 ? "These chats are correct" : `Confirm export of ${sessions.length} chats`}</button>
    </div>
  </dialog>;
}
