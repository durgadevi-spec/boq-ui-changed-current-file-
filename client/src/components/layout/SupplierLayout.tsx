import { useLocation } from "wouter";
import {
  LayoutDashboard,
  Package,
  MessageSquare,
  LogOut,
  Menu,
  X,
  FileText,
  Hammer,
  Settings,
  ChevronRight,
  Truck,
} from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";

interface SupplierLayoutProps {
  children: React.ReactNode;
  shopName?: string;
  shopLocation?: string;
  shopApproved?: boolean;
}

const navItems = [
  { label: "Dashboard",        icon: LayoutDashboard, path: "/supplier/dashboard" },
  { label: "Manage Materials", icon: Package,          path: "/supplier/materials" },
  { label: "Delivery Tracker", icon: Truck,            path: "/delivery-tracker" },
  { label: "Proposal",         icon: FileText,         path: "/proposal" },
  { label: "Sketch a Plan",    icon: Hammer,           path: "/sketch-plans" },
  { label: "Manage Product",   icon: Settings,         path: "/admin/manage-product" },
  { label: "Messages",         icon: MessageSquare,    path: "/supplier/support" },
];

export function SupplierLayout({
  children,
  shopName = "My Shop",
  shopLocation = "",
  shopApproved = false,
}: SupplierLayoutProps) {
  const [location, setLocation] = useLocation();
  const { logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = () => {
    logout();
    setLocation("/");
  };

  const navigate = (path: string) => {
    setLocation(path);
    setMobileOpen(false);
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full bg-[#0F172A]">
      {/* Brand */}
      <div className="px-6 py-10">
        <div className="flex flex-col gap-1.5">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-blue-500/10 border border-blue-500/20 w-fit">
            <span className="text-[10px] font-black uppercase tracking-[0.15em] text-blue-400">Vendor Portal</span>
          </div>
          <h2 className="text-xl font-black text-white leading-tight truncate tracking-tight mt-2">{shopName}</h2>
          {shopLocation && (
            <div className="flex items-center gap-2 mt-1 opacity-60">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <p className="text-[11px] font-bold text-slate-300 truncate uppercase tracking-widest">{shopLocation}</p>
            </div>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-4 space-y-2 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = location === item.path || location.startsWith(item.path + "/");
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={`
                w-full flex items-center gap-3.5 px-4 py-3.5 rounded-2xl text-[13px] font-bold
                transition-all duration-300 group relative
                ${isActive
                  ? "bg-blue-600 text-white shadow-xl shadow-blue-900/40"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
                }
              `}
            >
              <Icon
                size={18}
                strokeWidth={isActive ? 2.5 : 2}
                className={isActive ? "text-white" : "text-slate-500 group-hover:text-slate-300"}
              />
              <span className="flex-1 text-left tracking-tight">{item.label}</span>
              {isActive && (
                <div className="flex items-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-white/40" />
                  <ChevronRight size={14} className="ml-1 opacity-40" />
                </div>
              )}
            </button>
          );
        })}
      </nav>

      {/* Logout */}
      <div className="px-4 py-8 border-t border-slate-800/50">
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-2xl text-[13px] font-bold text-slate-500 hover:bg-rose-500/10 hover:text-rose-400 transition-all duration-300 group"
        >
          <div className="p-1.5 rounded-lg bg-slate-800/50 group-hover:bg-rose-500/20 transition-colors">
            <LogOut size={16} strokeWidth={2.5} />
          </div>
          <span>Account Sign Out</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-[#F8FAFC] overflow-hidden">
      {/* ── Desktop Sidebar (always visible) ── */}
      <aside className="hidden lg:flex flex-col w-64 bg-[#0F172A] flex-shrink-0 shadow-2xl">
        <SidebarContent />
      </aside>

      {/* ── Mobile Overlay ── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Mobile Drawer ── */}
      <aside
        className={`
          fixed top-0 left-0 h-full w-72 bg-[#0F172A] z-50
          transform transition-transform duration-500 cubic-bezier(0.4, 0, 0.2, 1) lg:hidden
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        <div className="flex items-center justify-between px-6 py-6 border-b border-slate-800/50">
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Navigation Menu</span>
          <button onClick={() => setMobileOpen(false)} className="p-2 bg-slate-800 text-slate-400 hover:text-white rounded-xl transition-all">
            <X size={20} />
          </button>
        </div>
        <SidebarContent />
      </aside>

      {/* ── Main Content ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <header className="lg:hidden flex items-center gap-4 px-6 py-4 bg-[#0F172A] border-b border-slate-800/50 flex-shrink-0 shadow-lg">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2.5 bg-slate-800/50 text-slate-300 hover:text-white rounded-xl active:scale-95 transition-all"
          >
            <Menu size={20} />
          </button>
          <div className="min-w-0">
            <p className="text-sm font-black text-white truncate tracking-tight">{shopName}</p>
            {shopLocation && <p className="text-[10px] font-bold text-blue-400 uppercase tracking-widest truncate">{shopLocation}</p>}
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
