import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout/Layout";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Truck,
    Package,
    Calendar,
    Building2,
    ChevronRight,
    Loader2,
    CheckCircle2,
    Clock,
    ExternalLink,
} from "lucide-react";
import apiFetch from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

interface PurchaseOrder {
    id: string;
    po_number: string;
    project_id: string;
    vendor_id: string;
    status: string;
    total_amount: string;
    delivery_date: string | null;
    dc_number: string | null;
    dc_date: string | null;
    created_at: string;
    project_name?: string;
    vendor_name?: string;
}

export default function DeliveryTracker() {
    const [, setLocation] = useLocation();
    const { toast } = useToast();
    const [orders, setOrders] = useState<PurchaseOrder[]>([]);
    const [loading, setLoading] = useState(true);
    const [updatingId, setUpdatingId] = useState<string | null>(null);

    // Delivery confirmation dialog state
    const [isConfirmingDelivery, setIsConfirmingDelivery] = useState(false);
    const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
    const [dcNumber, setDcNumber] = useState("");
    const [dcDate, setDcDate] = useState(new Date().toISOString().split('T')[0]);

    useEffect(() => {
        fetchOrders();
    }, []);

    const fetchOrders = async () => {
        try {
            setLoading(true);
            const res = await apiFetch("/api/purchase-orders?status=ordered");
            if (res.ok) {
                const data = await res.json();
                setOrders(data.purchaseOrders || []);
            }
        } catch (error) {
            toast({
                title: "Error",
                description: "Failed to load delivery data.",
                variant: "destructive",
            });
        } finally {
            setLoading(false);
        }
    };

    const handleDeliveryDateUpdate = async (id: string, date: string) => {
        setUpdatingId(id);
        try {
            const res = await apiFetch(`/api/purchase-orders/${id}/status`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ delivery_date: date }),
            });
            if (res.ok) {
                toast({ title: "Updated", description: "Expected delivery date updated." });
                fetchOrders();
            }
        } catch (error) {
            toast({ title: "Error", description: "Failed to update date", variant: "destructive" });
        } finally {
            setUpdatingId(null);
        }
    };

    const handleMarkDeliveredClick = (id: string) => {
        setSelectedOrderId(id);
        setIsConfirmingDelivery(true);
        setDcNumber("");
        setDcDate(new Date().toISOString().split('T')[0]);
    };

    const handleConfirmDelivery = async () => {
        if (!selectedOrderId) return;
        if (!dcNumber) {
            toast({ title: "Required", description: "DC Number is mandatory for delivery.", variant: "destructive" });
            return;
        }

        setUpdatingId(selectedOrderId);
        try {
            const res = await apiFetch(`/api/purchase-orders/${selectedOrderId}/status`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ 
                    status: "delivered",
                    dc_number: dcNumber,
                    dc_date: dcDate
                }),
            });
            if (res.ok) {
                toast({ title: "Success", description: "Order marked as delivered with DC." });
                setIsConfirmingDelivery(false);
                fetchOrders();
            }
        } catch (error) {
            toast({ title: "Error", description: "Failed to update status", variant: "destructive" });
        } finally {
            setUpdatingId(null);
            setSelectedOrderId(null);
        }
    };

    if (loading) {
        return (
            <Layout>
                <div className="flex flex-col items-center justify-center min-h-[60vh]">
                    <Loader2 className="h-10 w-10 animate-spin text-primary mb-4" />
                    <p className="text-muted-foreground">Loading delivery tracker...</p>
                </div>
            </Layout>
        );
    }

    return (
        <Layout>
            <div className="space-y-6">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                        <Truck className="h-8 w-8 text-indigo-600" />
                        Delivery Tracker
                    </h1>
                    <p className="text-muted-foreground">Monitor and track orders currently in transit or production.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                    <Card className="bg-indigo-50 border-indigo-100">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-bold uppercase text-indigo-600">Active Shipments</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="text-3xl font-bold text-indigo-900">{orders.length}</div>
                        </CardContent>
                    </Card>
                </div>

                <Card className="border-slate-200 shadow-sm">
                    <CardHeader className="bg-slate-50/50 border-b">
                        <CardTitle className="text-lg font-semibold flex items-center gap-2">
                            <Package className="h-5 w-5 text-slate-500" />
                            In-Transit Orders
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="font-bold">PO Number</TableHead>
                                    <TableHead className="font-bold">Project / Vendor</TableHead>
                                    <TableHead className="font-bold">Expected Delivery</TableHead>
                                    <TableHead className="font-bold">DC info</TableHead>
                                    <TableHead className="font-bold">Status</TableHead>
                                    <TableHead className="text-right font-bold w-[200px]">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {orders.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={6} className="text-center py-12 text-muted-foreground italic">
                                            No active orders in transit.
                                        </TableCell>
                                    </TableRow>
                                ) : (
                                    orders.map((po) => (
                                        <TableRow key={po.id} className="hover:bg-slate-50/50">
                                            <TableCell>
                                                <div className="font-bold text-primary">{po.po_number}</div>
                                                <div className="text-[10px] text-muted-foreground uppercase font-bold mt-1">
                                                    Created: {new Date(po.created_at).toLocaleDateString()}
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <div className="space-y-1">
                                                    <div className="flex items-center gap-2 text-sm font-medium">
                                                        <Building2 className="h-3 w-3 text-slate-400" />
                                                        {po.project_name || "N/A"}
                                                    </div>
                                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                                        <Truck className="h-3 w-3" />
                                                        {po.vendor_name || "N/A"}
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex items-center gap-2">
                                                    <Input
                                                        type="date"
                                                        defaultValue={po.delivery_date ? po.delivery_date.split('T')[0] : ""}
                                                        className="h-8 w-36 text-xs"
                                                        onChange={(e) => handleDeliveryDateUpdate(po.id, e.target.value)}
                                                        disabled={updatingId === po.id}
                                                    />
                                                    {updatingId === po.id && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <div className="text-xs text-slate-500 italic">
                                                    {po.dc_number ? (
                                                        <div className="flex flex-col">
                                                            <span className="font-semibold text-slate-700">DC: {po.dc_number}</span>
                                                            {po.dc_date && <span>Date: {new Date(po.dc_date).toLocaleDateString()}</span>}
                                                        </div>
                                                    ) : "Not issued"}
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant="outline" className="bg-indigo-50 text-indigo-600 border-indigo-200">
                                                    <Clock size={12} className="mr-1" /> In Transit
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex justify-end gap-2">
                                                    <Button variant="outline" size="sm" onClick={() => setLocation(`/purchase-orders/${po.id}`)}>
                                                        <ExternalLink className="h-4 w-4 mr-1" /> Details
                                                    </Button>
                                                    <Button
                                                        className="bg-emerald-600 hover:bg-emerald-700 text-white"
                                                        size="sm"
                                                        onClick={() => handleMarkDeliveredClick(po.id)}
                                                        disabled={updatingId === po.id}
                                                    >
                                                        <CheckCircle2 className="h-4 w-4 mr-1" /> Delivered
                                                    </Button>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))
                                )}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            </div>

            {/* Delivery Confirmation Dialog */}
            <Dialog open={isConfirmingDelivery} onOpenChange={setIsConfirmingDelivery}>
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-emerald-600">
                            <CheckCircle2 className="h-5 w-5" />
                            Confirm Delivery
                        </DialogTitle>
                        <DialogDescription>
                            Please enter the Delivery Challan (DC) details provided at the site.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <label htmlFor="dc_number" className="text-sm font-medium">DC Number <span className="text-red-500">*</span></label>
                            <Input
                                id="dc_number"
                                placeholder="Enter DC Number (e.g. DC-2024-001)"
                                value={dcNumber}
                                onChange={(e) => setDcNumber(e.target.value)}
                            />
                        </div>
                        <div className="grid gap-2">
                            <label htmlFor="dc_date" className="text-sm font-medium">DC Date</label>
                            <Input
                                id="dc_date"
                                type="date"
                                value={dcDate}
                                onChange={(e) => setDcDate(e.target.value)}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsConfirmingDelivery(false)}>Cancel</Button>
                        <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={handleConfirmDelivery} disabled={!dcNumber || updatingId !== null}>
                            {updatingId !== null ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                            Confirm & Mark Delivered
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Layout>
    );
}

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter
} from "@/components/ui/dialog";
