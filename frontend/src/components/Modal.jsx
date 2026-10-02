import { useEffect, useRef } from "react";
import { addToastHost, removeToastHost } from "../utils/toastHost";
import "./Modal.css";

/**
 * The application modal, built on the native <dialog>.
 *
 * It replaces react-modal-sheet, which only made the panel visible through a
 * requestAnimationFrame-driven transform animation: with system animations
 * turned off the transform never reached its destination and the panel stayed
 * mounted below the viewport, with page scrolling already locked. Here the
 * position comes from CSS and the animation is purely decorative.
 *
 * `size="wide"` widens the card on desktop: it is for the forms that carry a
 * table of their own (the account detail with its holdings), where 640px force
 * every row to wrap even on a screen with room to spare.
 */
const Modal = ({ isOpen, onClose, label, size = "default", children }) => {
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      dialog.showModal();
      // showModal() would focus the first focusable element: on the forms that
      // is the note field, and on a phone the keyboard would jump up in your
      // face. The focus stays on the dialog, which is itself a focusable
      // container and keeps the focus trap.
      dialog.focus();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
    if (!isOpen) return;
    // The toasts move in while it is open (utils/toastHost.js).
    addToastHost(dialog);
    return () => removeToastHost(dialog);
  }, [isOpen]);

  // Locking the background scroll. It is safe here: the dialog is already
  // visible when we apply it, whereas before the lock also kicked in when the
  // panel was nowhere to be seen — which is what made the UI feel frozen.
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);

  const handleCancel = (e) => {
    // Esc: the inner components already handle it (the keypad closes the form,
    // the type select merely leaves the select). Letting the native behaviour
    // through would make Esc inside a select close the whole form.
    e.preventDefault();
  };

  // Click on the backdrop: the target is the dialog itself only when the
  // ::backdrop is hit, because all the content lives inside .modal-body.
  const handleClick = (e) => {
    if (e.target === dialogRef.current) onClose?.();
  };

  return (
    <dialog
      ref={dialogRef}
      className={size === "wide" ? "modal modal--wide" : "modal"}
      tabIndex={-1}
      aria-label={label}
      onCancel={handleCancel}
      onClose={() => onClose?.()}
      onClick={handleClick}
    >
      <div className="modal-grip" aria-hidden="true" />
      {/* The content only lives while the modal is open: the forms inside
          initialise their state from the props at mount (amount, note, account,
          category, date). Kept mounted while closed, that state would stay the
          one from the first render — with the transaction modal freshly
          mounted, transaction is null, so the amount of the transaction you
          click would never show up. */}
      <div className="modal-body">{isOpen ? children : null}</div>
    </dialog>
  );
};

export default Modal;
