/** @type {import('tailwindcss').Config} */
export default {
  content: ["./frontend/index.html", "./frontend/src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        gradeflow: { ink: "#253044", navy: "#172333", blue: "#285bc5" },
      },
    },
  },
  plugins: [],
};
