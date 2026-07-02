import Chat from "@/components/Chat";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-white">
      <header className="border-b border-zinc-200 px-4 py-3">
        <h1 className="text-lg font-semibold">APIM Assistant</h1>
      </header>
      <Chat />
    </div>
  );
}
