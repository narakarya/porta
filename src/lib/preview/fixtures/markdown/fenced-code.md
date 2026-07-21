```elixir title=example.ex
defmodule Example do
  @moduledoc "demo"
  def run(arg) when is_binary(arg) do
    {:ok, arg}
  end
end
```
