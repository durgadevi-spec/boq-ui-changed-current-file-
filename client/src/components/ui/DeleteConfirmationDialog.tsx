import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface DeleteConfirmationDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (action: "archive" | "trash") => void;
  title?: string;
  itemName?: string;
  permanentDelete?: boolean;
}

export function DeleteConfirmationDialog({
  isOpen,
  onOpenChange,
  onConfirm,
  title,
  itemName,
  permanentDelete = false
}: DeleteConfirmationDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title || `Remove "${itemName || 'Item'}"?`}</DialogTitle>
          <DialogDescription className="pt-2">
            {permanentDelete ? (
              "This action cannot be undone. The item will be permanently deleted."
            ) : (
              <>
                Where would you like to move this item?
                <ul className="list-disc pl-5 mt-2 space-y-1 text-left">
                  <li><strong>Archive:</strong> Safe storage, securely hidden but can be restored anytime.</li>
                  <li><strong className="text-destructive">Trash:</strong> Will be automatically and permanently deleted after 30 days.</li>
                </ul>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex justify-end gap-2 mt-4 sm:flex-row flex-col">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {permanentDelete ? (
            <Button variant="destructive" onClick={() => { onConfirm(); onOpenChange(false); }}>Delete Permanently</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => { onConfirm('archive'); onOpenChange(false); }}>Archive</Button>
              <Button variant="destructive" onClick={() => { onConfirm('trash'); onOpenChange(false); }}>Trash</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
