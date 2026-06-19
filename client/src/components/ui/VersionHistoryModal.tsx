import React, { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { History, Clock, User, FileText, Plus, Trash2, Download } from "lucide-react";
import { format } from "date-fns";
import apiFetch from "@/lib/api";
import { Button } from "@/components/ui/button";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export interface VersionHistoryModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  versionId: string | null;
}

export function VersionHistoryModal({ isOpen, onOpenChange, versionId }: VersionHistoryModalProps) {
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen && versionId) {
      fetchHistory();
    }
  }, [isOpen, versionId]);

  const fetchHistory = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/boq-versions/${versionId}/history`);
      if (res.ok) {
        const data = await res.json();
        const filteredHistory = (data.history || []).filter((entry: any) => {
          const action = (entry.action || '').toLowerCase();
          return action !== 'approved' && action !== 'pending_approval' && action !== 'rejected';
        });
        setHistory(filteredHistory);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadPdf = () => {
    if (!history || history.length === 0) return;
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text("Version History Log", 14, 20);
    
    autoTable(doc, {
      startY: 30,
      head: [["Date", "User", "Action", "Item Name", "Reason"]],
      body: history.map(entry => [
        format(new Date(entry.created_at), 'MMM d, yyyy h:mm a'),
        entry.user_full_name || 'System User',
        entry.action,
        entry.item_name || 'Unknown Item',
        entry.reason || '-'
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [41, 128, 185] }
    });
    
    doc.save(`Version_History_${versionId || 'Export'}.pdf`);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-white border-slate-200">
        <DialogHeader className="flex flex-row items-start justify-between pr-8">
          <div>
            <DialogTitle className="flex items-center gap-2 text-slate-800">
              <History className="h-5 w-5 text-blue-500" />
              Version History
            </DialogTitle>
            <DialogDescription className="text-slate-500 mt-1">
              Activity and item changes for this version.
            </DialogDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownloadPdf}
            disabled={loading || history.length === 0}
            className="flex items-center gap-2 text-blue-600 border-blue-200 hover:bg-blue-50"
          >
            <Download className="h-4 w-4" />
            Download PDF
          </Button>
        </DialogHeader>
        
        <div className="py-4 max-h-[60vh] overflow-y-auto space-y-4 pr-2">
          {loading ? (
            <div className="text-center text-slate-500 py-8">Loading history...</div>
          ) : history.length === 0 ? (
            <div className="text-center text-slate-500 py-8">No history recorded yet.</div>
          ) : (
            history.map((entry, idx) => (
              <div key={entry.id || idx} className="flex gap-4 p-3 rounded-lg border border-slate-100 bg-slate-50">
                <div className="shrink-0 mt-1">
                  {entry.action === 'ADDED' ? (
                    <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center text-green-600">
                      <Plus className="h-4 w-4" />
                    </div>
                  ) : entry.action === 'DELETED' ? (
                    <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center text-red-600">
                      <Trash2 className="h-4 w-4" />
                    </div>
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-slate-600">
                      <FileText className="h-4 w-4" />
                    </div>
                  )}
                </div>
                <div className="flex-1 space-y-1">
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="font-bold text-slate-800 text-sm">
                        {entry.action === 'ADDED' ? 'Added Item: ' : entry.action === 'DELETED' ? 'Deleted Item: ' : ''}
                      </span>
                      <span className="text-sm text-slate-600">{entry.item_name || 'Unknown Item'}</span>
                    </div>
                    <span className="text-[11px] text-slate-400 flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {format(new Date(entry.created_at), 'MMM d, yyyy h:mm a')}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-[12px] text-slate-500">
                    <User className="h-3 w-3" />
                    {entry.user_full_name || 'System User'}
                  </div>
                  {entry.reason && (
                    <div className="mt-2 p-2 bg-white rounded border border-slate-200 text-[12px] text-slate-700">
                      <span className="font-semibold text-slate-600">Reason:</span> {entry.reason}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
