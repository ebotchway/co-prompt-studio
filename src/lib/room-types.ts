export type EditableField =
  | "prompt_a"
  | "prompt_b"
  | "system_prompt"
  | "test_input"
  | "temperature";

export type StudioRoom = {
  code: string;
  prompt_a: string;
  prompt_b: string;
  system_prompt: string;
  test_input: string;
  temperature: number;
  result_a: unknown | null;
  result_b: unknown | null;
  updated_at: string;
  created_at: string;
};

export type RoomEdit = {
  sender: string;
  field: EditableField;
  value: string | number;
};
