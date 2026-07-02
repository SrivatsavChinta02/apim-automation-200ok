import AppHeader from "@/components/AppHeader";
import Chat from "@/components/Chat";

export default function Home() {
  return (
    <div className="h-screen flex flex-col max-w-3xl mx-auto bg-[var(--surface)]">
      <AppHeader />
      <Chat />
    </div>
  );
}
