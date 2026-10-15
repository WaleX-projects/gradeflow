import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const mockedAuth = vi.hoisted(() => ({
  login: vi.fn().mockResolvedValue(undefined),
  register: vi
    .fn()
    .mockResolvedValue({
      message: "Check your email",
      verification_path: "/verify?token=development-only-test-token",
    }),
}));
vi.mock("./auth", () => ({ useAuth: () => mockedAuth }));

import { AuthPage } from "./AuthPage";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(mode: "login" | "register") {
  return render(
    <MemoryRouter>
      <AuthPage mode={mode} />
    </MemoryRouter>,
  );
}

describe("GradeFlow authentication forms", () => {
  it("announces invalid email and submits a valid sign-in to the authentication service", async () => {
    const user = userEvent.setup();
    renderPage("login");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText("Enter a valid email")).toBeTruthy();
    await user.type(
      screen.getByLabelText("Email address"),
      "marker@school.example",
    );
    await user.type(screen.getByLabelText("Password"), "valid-test-password");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await vi.waitFor(() =>
      expect(mockedAuth.login).toHaveBeenCalledWith({
        email: "marker@school.example",
        password: "valid-test-password",
      }),
    );
  });

  it("requires a school name and a 12-character password before account registration", async () => {
    const user = userEvent.setup();
    renderPage("register");
    await user.type(screen.getByLabelText("Your name"), "Test Owner");
    await user.type(
      screen.getByLabelText("Email address"),
      "owner@school.example",
    );
    await user.type(
      screen.getByLabelText("Password (at least 12 characters)"),
      "short",
    );
    await user.click(
      screen.getByRole("button", { name: /create school workspace/i }),
    );
    expect(await screen.findByText("Enter your school name")).toBeTruthy();
    expect(screen.getByText("Use at least 12 characters")).toBeTruthy();
    expect(mockedAuth.register).not.toHaveBeenCalled();
  });
});
