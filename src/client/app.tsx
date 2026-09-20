import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { ClipboardCheck, FolderCheck, ShieldCheck } from "lucide-react";
import Tenders from "./routes/tenders";
import Tender from "./routes/tender";
import Profile from "./routes/profile";

const NAV = [
  { to: "/tenders", label: "Tenders", icon: FolderCheck },
  { to: "/profile", label: "Our profile", icon: ShieldCheck },
];

export default function App() {
  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-[16.25rem] shrink-0 flex-col border-r border-border bg-surface md:flex">
        {/* h-14 here and on Toolbar: the sidebar brand row and the page header
            must share one height so their bottom borders form a single
            unbroken line across the app. Padding-derived heights drift the
            moment a page title gains or loses a subtitle. */}
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <ClipboardCheck className="size-4 text-primary" strokeWidth={2.5} />
          <span className="text-sm font-semibold">OpenTender</span>
        </div>
        <nav className="p-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  isActive
                    ? "bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] font-semibold text-primary"
                    : "text-foreground hover:bg-sunken"
                }`
              }
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/tenders" replace />} />
          <Route path="/tenders" element={<Tenders />} />
          <Route path="/tenders/:id" element={<Tender />} />
          <Route path="/profile" element={<Profile />} />
        </Routes>
      </main>
    </div>
  );
}
